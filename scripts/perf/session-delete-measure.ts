/**
 * Public sessions.delete on a synthetic 10,800-session fixture, 40 bundled plugins,
 * archived dashboards with already removed worktrees. No production target or models.
 * node --import ./scripts/tsx.mjs scripts/perf/session-delete-measure.ts --state-dir .local/delete-base --seed
 * node --import ./scripts/tsx.mjs scripts/perf/session-delete-measure.ts --state-dir .local/delete-base --samples 20
 * Repeat with fresh state and the other built revision; keep first cold request separate.
 * --phases instruments built owner functions and records worker fsyncs: diagnostic only.
 * Phase durations nest; do not sum them. This is a deletion workload, not the canonical
 * ten-minute Team stress campaign. Export bytes and source removal are verified offline.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import {
  generateTeamShapeStressFixture,
  TEAM_STRESS_PLUGIN_IDS,
} from "./team-shape-stress-fixture.ts";
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    phases: { type: "boolean" },
    samples: { type: "string", default: "20" },
    entry: { type: "string", default: "dist/entry.js" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 100, "samples must be 1..100");
let port = await getFreePort();
while (port < 40000) {
  port = await getFreePort();
}
if (values.seed) {
  const { summary, env } = await generateTeamShapeStressFixture({
    stateDir: root,
    port,
    seed: 1841,
    now: 1792998000000,
    sessions: 10800,
    transcriptMiB: 128,
  });
  const { runOpenClawStateWriteTransaction, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.ts");
  const { updateRegistryWorktreeInDatabase } =
    await import("../../src/agents/worktrees/registry-run-end.worker.ts");
  for (const worktree of summary.projectWorktrees) {
    execFileSync("git", ["-C", worktree.repoRoot, "worktree", "remove", worktree.path], { env });
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        updateRegistryWorktreeInDatabase(db, {
          id: worktree.id,
          patch: { removedAt: summary.now },
        }),
      { env },
    );
  }
  await closeOpenClawStateDatabaseAsync();
  console.log(JSON.stringify(summary));
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert(
  fixture.format === "openclaw-team-shape-v1" && fixture.sessionCount === 10800,
  "requires the synthetic fixture",
);
const output = path.join(root, `delete-${Date.now()}`);
mkdirSync(output);
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
cfg.plugins = {
  ...cfg.plugins,
  enabled: true,
  allow: [...TEAM_STRESS_PLUGIN_IDS],
  entries: Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
};
writeFileSync(path.join(output, "openclaw.json"), JSON.stringify(cfg));
const preload = fileURLToPath(new URL("./session-delete-phases-loader.mjs", import.meta.url));
const env = createGatewayBenchEnv(path.join(root, "home"), path.join(output, "openclaw.json"), {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_PROFILE: "delete-benchmark",
    TMPDIR: path.join(root, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-delete-benchmark",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.delete-benchmark",
    ...(values.phases
      ? { NODE_OPTIONS: `--import=${preload}`, OPENCLAW_DELETE_PHASE_OUTPUT: output }
      : {}),
  },
});
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(output, "openclaw.json"),
});
const { loadTranscriptEvents, loadSessionEntry } =
  await import("../../src/config/sessions/session-accessor.ts");
const { readSessionArchiveContentSync } =
  await import("../../src/config/sessions/archive-compression.ts");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.ts");
const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
const targets = [];
for (let index = 700; index < 700 + samples; index++) {
  const sessionKey = `agent:main:dashboard:${(index + 1).toString(16).padStart(8, "0")}-1659-4000-8000-000000000001`;
  const scope = { sessionKey, sessionId: `team-shape-session-${index}`, storePath };
  const events = await loadTranscriptEvents(scope);
  assert(events.length > 0, "fresh transcript required");
  targets.push({ scope, jsonl: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
}
await closeOpenClawAgentDatabasesAsync();
const log = createWriteStream(path.join(output, "gateway.log"));
const child = spawn(process.execPath, buildGatewayBenchChildArgs(values.entry, port), {
  detached: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env,
});
child.stdout?.pipe(log);
child.stderr?.pipe(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const results: Array<{
  key: string;
  ms: number;
  phases?: unknown;
  archived: string[];
  hostLoad: number[];
}> = [];
try {
  const deadline = Date.now() + 180000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Gateway setup failed: ${output}`);
    }
    await delay(500);
  }
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  client.ws.on("error", () => {});
  await client.waitOpen();
  async function rpc(method: string, params: unknown) {
    const response = await client!.request(method, params, 120000);
    assert(response.ok, JSON.stringify({ method, error: response.error }));
    return response.payload;
  }
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-delete-measurement",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    caps: [],
  });
  await rpc("sessions.list", { limit: 10 });
  for (const target of targets) {
    if (values.phases) {
      child.send({ channel: "delete-phase", action: "reset" });
    }
    const started = performance.now();
    const response = await rpc("sessions.delete", {
      key: target.scope.sessionKey,
      deleteTranscript: true,
      archivedOnly: true,
    });
    const ms = performance.now() - started;
    assert(
      response &&
        typeof response === "object" &&
        "deleted" in response &&
        response.deleted === true &&
        "archived" in response &&
        Array.isArray(response.archived),
      "delete must commit and return an archive",
    );
    assert(!("worktreePreserved" in response), "removed worktrees need no preservation");
    const archived: string[] = response.archived;
    assert(
      archived.length === 1 && readSessionArchiveContentSync(archived[0]!) === target.jsonl,
      "archive must preserve exact transcript bytes",
    );
    const phases = values.phases
      ? await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.off("message", receive);
            resolve({ error: "phase capture timeout" });
          }, 5000);
          const receive = (message: unknown) => {
            if (
              message &&
              typeof message === "object" &&
              "channel" in message &&
              message.channel === "delete-phase"
            ) {
              clearTimeout(timer);
              child.off("message", receive);
              resolve(message);
            }
          };
          child.on("message", receive);
          child.send({ channel: "delete-phase", action: "snapshot" });
        })
      : undefined;
    results.push({ key: target.scope.sessionKey, ms, phases, archived, hostLoad: loadavg() });
    writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(
        { entry: path.resolve(values.entry), diagnostic: values.phases ?? false, samples: results },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ sample: results.length, ms }));
  }
} finally {
  client?.close();
  await stopChild(child, { teardownGraceMs: 10000 });
  log.end();
}
for (const target of targets) {
  assert(
    loadSessionEntry(target.scope) === undefined,
    "deleted entry must stay absent after shutdown",
  );
}
await closeOpenClawAgentDatabasesAsync();
console.log(`Verified exact archives and absent session entries: ${output}`);
