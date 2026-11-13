/** Real Gateway + bundled iMessage /usage cost; synthetic fixtures only. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import { measureGatewayCpuUsage, readGatewayCpuUsage } from "./lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
  waitForInitialProbe,
} from "./lib/gateway-bench-runtime.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./perf/team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    clients: { type: "string", default: "4" },
    samples: { type: "string", default: "5" },
    "transcript-mib": { type: "string", default: "16" },
    "long-transcript-entries": { type: "string", default: "2000" },
    probe: { type: "boolean", default: false },
    "counts-only": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    resources: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node --import ./scripts/tsx.mjs scripts/bench-session-cost-ready.mts --out <NEW DIR> --observer <frozen observer.cjs> [--clients 4] [--samples 5] [--counts-only] [--probe] [--cpu-profile] [--resources]\n" +
      "Seeds synthetic transcripts offline, then sends /usage cost concurrently from separate iMessage peers.\n" +
      "One cold burst and repeated warm bursts are reported separately. The optional probe counts 25ms busy sleeps; omit it from latency runs.",
  );
  process.exit(0);
}
assert(values.out && values.observer, "--out and --observer are required");
assert(!values.probe || values["counts-only"], "--probe requires --counts-only");
const clients = Number(values.clients);
const samples = Number(values.samples);
assert(Number.isSafeInteger(clients) && clients >= 2 && clients <= 20);
assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100);
const output = path.resolve(values.out);
mkdirSync(output, { mode: 0o700 });
const fixture = path.join(output, "fixture");
const port = await getFreePort();
const mockPort = await getFreePort();
const senders = Array.from(
  { length: clients },
  (_, index) => `+1555555${String(index).padStart(4, "0")}`,
);
const expectedUsage = senders.map((_, index) => ({ tokens: 100 + index * 10, cost: index + 1 }));
const events: object[] = [];
const children: ChildProcess[] = [];
const evidence = {
  format: "session-cost-ready-v1",
  harnessVersion: "3.1.4",
  children: [] as { name: string; pid: number }[],
  turns: [],
  clients,
  samples,
  probeEnabled: values.probe,
  countsOnly: values["counts-only"],
  // Samples within a run share a process; cold AB samples require fresh --out directories.
  phases: [] as { phase: string; start: number; end: number }[],
  bursts: [] as {
    phase: string;
    replyCount: number;
    verifiedSessionDetails: number;
    latencyMs: number[];
    cpu?: unknown;
  }[],
  expectedSessionUsage: expectedUsage,
  cpuProfile: values["cpu-profile"],
  ok: false,
  error: undefined as string | undefined,
};
let phase = "fixture";
let phaseStart = Date.now();
let gateway: ChildProcess | undefined;
let watches = 0;
let sent = 0;
let activeBurst: { start?: number; latencyMs: number[]; replies: Set<number> } | undefined;
let bridgeFailure: Error | undefined;
let cleaned = false;
const setPhase = (next: string) => {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase"), phase);
};
writeFileSync(path.join(output, "phase"), phase);
const server = createServer((req, res) => {
  void handleRequest(req, res);
});
async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  if (req.url === "/watch") {
    watches++;
  }
  if (req.url === "/sent") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        text?: string;
        chat_id?: number;
        to?: string;
      };
      const index =
        typeof reply.chat_id === "number" ? reply.chat_id - 1 : senders.indexOf(reply.to ?? "");
      const expected = expectedUsage[index];
      assert(activeBurst && expected, "Unexpected reply target or phase");
      assert(!activeBurst.replies.has(index), "Duplicate cost reply for a peer");
      assert(
        typeof reply.text === "string" && reply.text.includes("Usage cost"),
        "Reply is not a cost summary",
      );
      const detail = /^Session \$(\d+\.\d+)(?: \(partial\))? · (\d+) tokens$/mu.exec(reply.text);
      assert(detail, "Missing billed session detail");
      assert.equal(Number(detail[1]), expected.cost, "Wrong session cost");
      assert.equal(Number(detail[2]), expected.tokens, "Wrong session token total");
      activeBurst.replies.add(index);
      if (activeBurst.start !== undefined) {
        activeBurst.latencyMs.push(performance.now() - activeBurst.start);
      }
      sent++;
    } catch (error) {
      bridgeFailure = error instanceof Error ? error : new Error(String(error));
      res.statusCode = 500;
    }
  }
  req.on("error", (error) => {
    bridgeFailure = error;
  });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/next" ? events.splice(0) : {}));
}
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const bridgeUrl = `http://127.0.0.1:${address.port}`;
function launch(args: string[], env: NodeJS.ProcessEnv, name: string): ChildProcess {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  if (child.pid) {
    evidence.children.push({ name, pid: child.pid });
  }
  return child;
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (!predicate()) {
    if (bridgeFailure) {
      throw bridgeFailure;
    }
    assert(gateway?.exitCode === null, "Gateway exited during workload");
    assert(Date.now() < deadline, `${label} timed out`);
    await delay(10);
  }
}
async function cleanup(): Promise<void> {
  if (cleaned) {
    return;
  }
  cleaned = true;
  for (const child of children.toReversed()) {
    await stopChild(child, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setPhase("done");
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
try {
  const options = parseTeamShapeOptions([
    "--state-dir",
    fixture,
    "--sessions",
    String(clients),
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--transcript-mib",
    values["transcript-mib"],
    "--long-transcript-entries",
    values["long-transcript-entries"],
    "--long-transcript-sessions",
    String(clients),
    "--port",
    String(port),
  ]);
  const seeded = await generateTeamShapeFixture(options);
  // Complete native writes before Gateway custody. Each route owns one long
  // transcript with distinct billed usage and no precomputed usage cache.
  const previousEnv = process.env;
  try {
    process.env = { ...seeded.env };
    const [
      { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
      entries,
      state,
      { appendTranscriptEventsInTransaction },
    ] = await Promise.all([
      import("../src/state/openclaw-agent-db.js"),
      import("../src/config/sessions/session-accessor.sqlite-entry-store.js"),
      import("../src/state/openclaw-state-db.js"),
      import("../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
    ]);
    try {
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (const [index, sender] of senders.entries()) {
            const originalKey = `agent:main:team-shape-session-${index}`;
            const existing = entries.readExactSessionEntryRow(database, originalKey);
            assert(existing);
            const usage = expectedUsage[index]!;
            const now = Date.now();
            appendTranscriptEventsInTransaction(
              database,
              { agentId: "main", sessionKey: originalKey, sessionId: existing.entry.sessionId },
              [
                {
                  type: "message",
                  id: `synthetic-cost-${index}`,
                  timestamp: new Date(now).toISOString(),
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Synthetic billed usage." }],
                    timestamp: now,
                    provider: "openai",
                    model: "gpt-4.1",
                    usage: {
                      input: usage.tokens - 10,
                      output: 10,
                      totalTokens: usage.tokens,
                      cost: { total: usage.cost, totalOrigin: "provider-billed" },
                    },
                  },
                },
              ],
            );
            const { archivedAt: _archivedAt, ...entry } = existing.entry;
            entries.writeSessionEntry(database, `agent:main:imessage:direct:${sender}`, {
              ...entry,
              visibility: "shared",
              updatedAt: Date.now(),
              status: "done",
            });
            // The native deletion owner rehomes surviving transcript windows.
            entries.deleteSessionEntryRows(database, originalKey, {
              deleteOwnedWindows: true,
              validatedEntry: existing.entry,
            });
          }
        },
        { agentId: "main", env: seeded.env },
      );
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      await state.closeOpenClawStateDatabaseAsync();
    }
  } finally {
    process.env = previousEnv;
  }
  const configPath = path.join(fixture, "openclaw.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  cfg.agents = { ...cfg.agents, defaults: { ...cfg.agents?.defaults, skipBootstrap: true } };
  cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
  cfg.messages = { inbound: { debounceMs: 0 } };
  const bridge = path.join(fixture, "synthetic-imsg");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("scripts/perf/session-cost-ready-bridge.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  cfg.channels = {
    imessage: {
      enabled: true,
      cliPath: bridge,
      dbPath: path.join(fixture, "synthetic-chat.db"),
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  };
  cfg.plugins = {
    enabled: true,
    entries: {
      imessage: { enabled: true },
      browser: { enabled: false },
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    { PATH: process.env.PATH, HOME: fixture, MOCK_PORT: String(mockPort) },
    "mock",
  );
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30_000,
  });
  assert.equal(mockReady.status, 200, "Mock provider unavailable");
  setPhase("boot");
  gateway = launch(
    buildGatewayBenchChildArgs(values.entry, port, [
      ...(values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : []),
      ...(values.resources
        ? [
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            "./scripts/lib/gateway-bench-profile-preload.ts",
          ]
        : []),
    ]),
    {
      ...createGatewayBenchEnv(path.join(fixture, "home"), configPath, {
        caseEnv: { OPENCLAW_STATE_DIR: fixture },
      }),
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENAI_API_KEY: "synthetic-cost-fixture",
      INGRESS_BENCH_URL: bridgeUrl,
      SQLMEASURE_OUT: output,
      ...(values.probe ? { SESSION_COST_READY_PROBE: output } : {}),
      NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))}${values.probe ? ` --require=${JSON.stringify(path.resolve("scripts/perf/session-cost-ready-observer.cjs"))}` : ""} --enable-source-maps`,
    },
    "gateway",
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway?.exitCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway unavailable");
  await until(() => watches > 0, "iMessage watch");
  for (let sample = 0; sample <= samples; sample++) {
    const burstPhase = sample === 0 ? "cold" : `warm-${sample}`;
    setPhase(burstPhase);
    const before = values.resources
      ? await readGatewayCpuUsage(gateway, { includeWorkers: true })
      : undefined;
    const sentBefore = sent;
    activeBurst = {
      start: values["counts-only"] ? undefined : performance.now(),
      latencyMs: [],
      replies: new Set(),
    };
    for (const [index, sender] of senders.entries()) {
      events.push({
        id: sample * clients + index + 1,
        guid: `cost-ready-${sample}-${index}`,
        chat_id: index + 1,
        sender,
        text: "/usage cost",
        is_from_me: false,
        is_group: false,
        created_at: new Date().toISOString(),
      });
    }
    await until(() => sent >= sentBefore + clients, "cost replies");
    const latencyMs = activeBurst.latencyMs;
    const verifiedSessionDetails = activeBurst.replies.size;
    activeBurst = undefined;
    evidence.bursts.push({
      phase: burstPhase,
      replyCount: sent - sentBefore,
      verifiedSessionDetails,
      latencyMs,
      ...(before
        ? {
            cpu: measureGatewayCpuUsage(
              before,
              await readGatewayCpuUsage(gateway, { includeWorkers: true }),
            ),
          }
        : {}),
    });
    setPhase(`idle-${sample}`);
    await delay(250);
  }
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
if (gateway?.pid) {
  const result = await promisify(execFile)("python3", [
    path.join(path.dirname(path.resolve(values.observer)), "analyze.py"),
    output,
  ]);
  writeFileSync(path.join(output, "analysis.log"), result.stdout + result.stderr);
}
console.log(
  JSON.stringify({
    output,
    ok: evidence.ok,
    error: evidence.error,
    ...(values["counts-only"]
      ? { verifiedSessionDetails: evidence.bursts.map((burst) => burst.verifiedSessionDetails) }
      : {
          cold: summarizeNumbers(evidence.bursts[0]?.latencyMs ?? []),
          warm: summarizeNumbers(evidence.bursts.slice(1).flatMap((burst) => burst.latencyMs)),
        }),
  }),
);
