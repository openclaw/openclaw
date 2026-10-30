/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-diff-metadata-measure.ts
 *   --mode latency|timing|allocation [--iterations 3200] [--clients 64]
 * Run base/candidate serially in alternating order, at least five samples each.
 * For base, set OPENCLAW_BENCH_BASELINE_DIR to a directory containing the three
 * ownerFiles below at the baseline revision, preserving their relative paths.
 *
 * Exercises the actual diff handler, retained metadata lifetime and workspace
 * policy with 10k synthetic sessions/40 agents. Loader hooks replace ONLY the
 * metadata storage reply and Git result: this is an owner benchmark, not a
 * Gateway/SQLite/Git load test. Latency injects 2.2-second storage waits;
 * timing/allocation use separate passes with an asynchronous immediate reply.
 * Acceptance: 64 pending polls share one metadata read and return computing in
 * about two seconds, then yield the same diff on the next poll 500ms later.
 * Report uncontended --clients 1
 * alongside fanout CPU/allocation; do not hide any cost shifted to warm callers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { SessionsDiffResult } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3200" },
    clients: { type: "string", default: "64" },
  },
});
assert(["latency", "timing", "allocation"].includes(values.mode));
const integer = (name: "iterations" | "clients") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const clients = integer("clients");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
fs.mkdirSync(path.join(sourceRoot, ".local"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(sourceRoot, ".local/diff-metadata-measure-"));
process.env = createGatewayBenchEnv(scratch, path.join(scratch, "openclaw.json"), {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(scratch, "state") },
});
const ownerFiles = [
  "src/gateway/server-methods/sessions-diff.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/session-scoped-read.ts",
];
const loadedOwners = new Set<string>();
const hook = registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(sourceRoot, fileURLToPath(url)) : "";
    let source: string;
    if (ownerFiles.includes(relative)) {
      loadedOwners.add(relative);
      source = fs.readFileSync(path.join(baseline ?? sourceRoot, relative), "utf8");
    } else if (relative === "src/gateway/session-utils-store-worker.ts") {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadGatewaySessionEntryReadOnlyInWorker(",
          "async function unmeasuredMetadataRead(",
        );
      source +=
        "\nexport const loadGatewaySessionEntryReadOnlyInWorker = globalThis.__diffMetadataReply;\n";
    } else if (relative === "src/sessions/session-diff.ts") {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadCheckoutDiff(",
          "async function unmeasuredCheckoutDiff(",
        );
      source += "\nexport const loadCheckoutDiff = globalThis.__diffGitReply;\n";
    } else {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const cfg: OpenClawConfig = {
  agents: {
    defaults: { sandbox: { mode: "off" } },
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `agent-${index}`,
        { workspace: path.join(scratch, `agent-${index}`) },
      ]),
    ),
  },
};
const inventory = Array.from({ length: 10_000 }, (_, index) => {
  const agentId = `agent-${index % 40}`;
  const key = `agent:${agentId}:${index % 5 ? "subagent" : "dashboard"}:session-${index}`;
  return {
    agentId,
    key,
    entry: {
      sessionId: `session-${index}`,
      updatedAt: 1,
      spawnedCwd: path.join(scratch, "workspaces", `session-${index}`),
      skillsSnapshot: { prompt: "Synthetic retained instructions", skills: [] },
    } satisfies InternalSessionEntry,
  };
});
const rows = new Map(inventory.map((row) => [row.key, row]));
let metadataReads = 0;
let metadataDelayMs = 0;
const diff = (sessionKey: string): SessionsDiffResult => ({
  sessionKey,
  files: [
    {
      path: "fixture.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "-before\n+after\n",
    },
  ],
  additions: 1,
  deletions: 1,
});
Object.assign(globalThis, {
  __diffMetadataReply: async ({ key }: { key: string }) => {
    metadataReads++;
    await (metadataDelayMs ? delay(metadataDelayMs) : Promise.resolve());
    const row = rows.get(key);
    assert(row);
    return {
      cfg,
      agentId: row.agentId,
      canonicalKey: key,
      storePath: path.join(scratch, "state", "agents", row.agentId, "sessions", "sessions.json"),
      storeKeys: [key],
      store: { [key]: row.entry },
      entry: row.entry,
    };
  },
  __diffGitReply: async ({ sessionKey }: { sessionKey: string }) => diff(sessionKey),
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const { sessionsDiffHandlers } = await import("../../src/gateway/server-methods/sessions-diff.js");
const { createSubsystemLogger } = await import("../../src/logging/subsystem.js");
const handler = sessionsDiffHandlers["sessions.diff"];
assert(handler);
assert.deepEqual([...loadedOwners].toSorted(), ownerFiles.toSorted());
const context = {
  getRuntimeConfig: () => cfg,
  logGateway: createSubsystemLogger("bench/session-diff-metadata"),
} as GatewayRequestHandlerOptions["context"];
async function request(index: number, poll = true) {
  const { key, agentId } = inventory[index % inventory.length]!;
  const params = { sessionKey: key, agentId, poll };
  let result: SessionsDiffResult | undefined;
  await handler!({
    req: { type: "req", id: "synthetic", method: "sessions.diff", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    context,
    respond(ok, payload, error) {
      assert(ok, JSON.stringify(error));
      result = payload as SessionsDiffResult;
    },
  });
  assert(result);
  if (!result.computing) {
    assert.deepEqual(result, diff(key));
  }
  return result;
}
async function run(count: number, first = 0) {
  for (let offset = 0; offset < count; offset += clients) {
    await Promise.all(
      Array.from({ length: Math.min(clients, count - offset) }, () => request(first + offset)),
    );
  }
}
try {
  await run(Math.min(iterations, 128), 9800);
  metadataReads = 0;
  globalThis.gc?.();
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  let pendingReplies = 0;
  let latencyMs: number[] | undefined;
  if (values.mode === "latency") {
    metadataDelayMs = 2_200;
    latencyMs = await Promise.all(
      Array.from({ length: clients }, async () => {
        const reply = await request(9999);
        pendingReplies += Number(reply.computing === true);
        return performance.now() - started;
      }),
    );
  } else {
    await run(iterations);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  const operations = values.mode === "latency" ? clients : iterations;
  const reads = metadataReads;
  let completedAtMs: number | undefined;
  if (pendingReplies) {
    await delay(500);
    assert.deepEqual(await request(9999), diff(inventory[9999]!.key));
    completedAtMs = performance.now() - started;
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      arm: baseline ? "base" : "candidate",
      operations,
      clients,
      metadataReads: reads,
      hostLoad,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      ...(latencyMs
        ? { pendingReplies, completedAtMs, latencyMs: latencyMs.toSorted((a, b) => a - b) }
        : {}),
      ...(allocation
        ? { sampledBytesPerOperation: sumSampledHeapBytes(allocation.profile.head) / operations }
        : {
            cpuUsPerOperation: (cpu.user + cpu.system) / operations,
            wallUsPerOperation: (elapsedMs * 1000) / operations,
          }),
    }),
  );
} finally {
  hook.deregister();
  fs.rmSync(scratch, { recursive: true, force: true });
}
