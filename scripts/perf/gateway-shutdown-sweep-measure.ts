/**
 * Measures SIGTERM-to-exit while expired subagent retention runs on an isolated dist Gateway.
 * First create synthetic state with scripts/perf/team-shape-fixture.ts
 * --state-dir <synthetic-state-directory> --team-stress
 * --sessions 10800 --runs 4300 --settled-runs --transcript-mib 1 --projects 4 --approvals 24 --cron 40.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/gateway-shutdown-sweep-measure.ts
 *   <synthetic-state-directory> <new-output-directory> [reload-cycles=3] [--allocations]
 * Replay a fresh copy of the same offline fixture at the same path for each arm.
 * The script enables one-minute retention, 40 bundled plugins, one synthetic plugin,
 * and 65 clients. It never connects to an existing Gateway. Logs contain startup/close
 * phase traces; resources.jsonl records shutdown CPU, heap/RSS, GC and loop samples.
 * Allocation sampling is a separate diagnostic pass, not latency acceptance evidence.
 * This measures maintenance shutdown, not active model-turn recovery or steady-state throughput.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  createGatewayBenchEnv,
  buildGatewayBenchChildArgs,
  waitForInitialProbe,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { TEAM_STRESS_PLUGIN_IDS } from "./team-shape-stress-fixture.ts";
assert(process.argv[2] && process.argv[3], "Supply synthetic state and a new output directory");
const cycles = Number(process.argv[4] ?? "3");
assert(
  Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 100,
  "reload cycles must be 1..100",
);
const root = path.resolve(process.argv[2]);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
assert(isRecord(fixture) && fixture.format === "openclaw-team-shape-v1");
assert(typeof fixture.profile === "string");
const output = path.resolve(process.argv[3]);
mkdirSync(output, { mode: 0o700 });
let port = await getFreePort();
while (port < 40000) {
  port = await getFreePort();
}
const config = path.join(root, "openclaw.json");
const cfg: OpenClawConfig = JSON.parse(readFileSync(config, "utf8"));
// Exercise expired retention, rather than the stress fixture's protected 24-hour cohort.
cfg.agents = {
  ...cfg.agents,
  defaults: {
    ...cfg.agents?.defaults,
    subagents: { ...cfg.agents?.defaults?.subagents, archiveAfterMinutes: 1 },
  },
};
cfg.gateway = { ...cfg.gateway, port, mode: "local", bind: "loopback", auth: { mode: "none" } };
const plugin = writePluginFixtures(root, { count: 1, activationOnStartup: true });
cfg.plugins = {
  enabled: true,
  allow: [...TEAM_STRESS_PLUGIN_IDS, ...plugin.pluginIds],
  load: { paths: [plugin.pluginsDir] },
  entries: Object.fromEntries(
    [...TEAM_STRESS_PLUGIN_IDS, ...plugin.pluginIds].map((id) => [id, { enabled: true }]),
  ),
};
cfg.diagnostics = { enabled: true };
cfg.logging = { file: path.join(output, "gateway.jsonl"), level: "info", consoleLevel: "info" };
writeFileSync(config, JSON.stringify(cfg, null, 2));
const log = openSync(path.join(output, "gateway.log"), "w", 0o600);
const env = createGatewayBenchEnv(path.join(root, "home"), config, {
  startupTrace: true,
  restartTrace: true,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    TMPDIR: path.join(root, "tmp"),
    OPENAI_API_KEY: "synthetic-fixture",
    OPENCLAW_PROFILE: fixture.profile,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-team-shape-${port}`,
    OPENCLAW_SHUTDOWN_MEASURE_OUTPUT: output,
    OPENCLAW_SHUTDOWN_MEASURE_ALLOCATIONS: process.argv.includes("--allocations") ? "1" : "0",
  },
});
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve("dist/entry.js"), port, [
    "--import",
    fileURLToPath(new URL("./team-shape-stress-loader.mjs", import.meta.url)),
    "--import",
    fileURLToPath(new URL("./gateway-shutdown-sweep-preload.mjs", import.meta.url)),
  ]),
  { env, detached: true, stdio: ["ignore", log, log] },
);
closeSync(log);
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const result = {
  pid: gateway.pid,
  cycles,
  clients: 65,
  reloads: 0,
  created: 0,
  archived: 0,
  lists: 0,
  workloadCompleted: false,
  forcedKill: false,
  retentionActiveAtSignal: false,
  valid: false,
  shutdownMs: 0,
  exit: null as Awaited<ReturnType<typeof stopChild>> | null,
};
async function request(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
) {
  const r = await client.request(method, params, 120000);
  assert(r.ok, `${method}: ${JSON.stringify(r.error)}`);
  assert(isRecord(r.payload), `${method}: expected object response`);
  return r.payload;
}
function hasActiveSweep(sample: unknown) {
  return (
    isRecord(sample) &&
    Array.isArray(sample.roots) &&
    sample.roots.some((holder) => isRecord(holder) && holder.origin === "subagents:sweeper")
  );
}
try {
  const ready = await waitForInitialProbe({
    deadlineAt: performance.now() + 300000,
    startAt: performance.now(),
    path: "/readyz",
    port,
    isDone: () => gateway.exitCode !== null,
  });
  assert.equal(ready.status, 200);
  console.log("READY", gateway.pid, output);
  for (let i = 0; i < 65; i++) {
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}`, openTimeoutMs: 30000 });
    clients.push(client);
    await client.waitOpen();
    await request(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
        displayName: "synthetic-shutdown-proof",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    await request(client, "sessions.subscribe", {});
  }
  for (let i = 0; i < cycles; i++) {
    const key = `agent:main:shutdown-sweep-${path.basename(output)}-${i}`;
    const created = await request(clients[i % 65]!, "sessions.create", { key });
    assert.equal(typeof created.sessionId, "string");
    result.created++;
    await request(clients[i % 65]!, "sessions.patch", {
      key,
      archived: true,
      expectedSessionId: created.sessionId,
    });
    result.archived++;
    const reloaded = await request(clients[0]!, "plugins.reload", {
      plugins: [{ pluginId: "bench-plugin-01" }],
      waitForDrain: true,
    });
    assert.equal(reloaded.restartRequired, false);
    result.reloads++;
    await request(clients[i % 65]!, "sessions.list", {
      limit: 20,
      archived: "all",
      search: "shutdown-sweep",
    });
    result.lists++;
    console.log("ITERATION", i + 1);
    await delay(6500);
  }
  const waitingAt = Date.now();
  let activeSweep = false;
  while (Date.now() - waitingAt < 120_000) {
    const latest: unknown = JSON.parse(
      readFileSync(path.join(output, "resources.jsonl"), "utf8").trim().split("\n").at(-1)!,
    );
    if (
      isRecord(latest) &&
      typeof latest.at === "number" &&
      latest.at >= waitingAt &&
      hasActiveSweep(latest)
    ) {
      activeSweep = true;
      break;
    }
    await delay(100);
  }
  assert(activeSweep, "No active retention sweep observed within two minutes");
  result.workloadCompleted = true;
} finally {
  const start = performance.now();
  result.exit = await stopChild(gateway, {
    teardownGraceMs: 95000,
    killGraceMs: 2000,
    onForceKill: () => {
      result.forcedKill = true;
    },
  });
  result.shutdownMs = performance.now() - start;
  for (const client of clients) {
    client.close();
  }
  const samples: unknown[] = readFileSync(path.join(output, "resources.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  result.retentionActiveAtSignal = samples.some(
    (sample) => isRecord(sample) && sample.phase === "signal" && hasActiveSweep(sample),
  );
  result.valid =
    result.workloadCompleted &&
    result.retentionActiveAtSignal &&
    !result.forcedKill &&
    result.exit.exitCode === 0 &&
    result.exit.signal === null &&
    !result.exit.exitedBeforeTeardown;
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
assert(result.valid, "Invalid shutdown sample; inspect result.json and gateway.log");
