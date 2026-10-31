/**
 * Add unread-only RPC traffic to an already-running canonical Team stress Gateway:
 * node --import ./scripts/tsx.mjs scripts/perf/session-patch-commit-probe.ts \
 *   --state-dir .local/team-stress/timing-1-base \
 *   --config .local/team-stress/timing-1-base/broadcast-measure-<time>/openclaw.json \
 *   --output .local/unread-base.json --duration-ms 600000 --interval-ms 250
 * Add --port when the running Gateway CLI overrides the fixture config port.
 * Use the running arm's config, not its original offline fixture config. Only
 * generated fixtures beneath this checkout's .local and unauthenticated loopback
 * ports >=40000 are accepted. The probe creates no fixture/server and sends no
 * process signals. It marks each stress target unread, then read, before advancing.
 * Requests are serial: slow replies reduce achieved rate rather than building an
 * unbounded queue. Results include every request and raw timestamps for correlation
 * with the Gateway's patch phases, reservation holds, SQL holds, and stall profiles.
 * Client latency alone cannot distinguish writer wait, SQL, receipt publication,
 * or GC. Capture those existing server diagnostics alongside this output.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    config: { type: "string" },
    output: { type: "string" },
    port: { type: "string" },
    "duration-ms": { type: "string", default: "600000" },
    "interval-ms": { type: "string", default: "250" },
  },
});
assert(
  values["state-dir"] && values.config && values.output,
  "Require --state-dir, --config, --output",
);
const stateDir = await realpath(values["state-dir"]);
const configPath = await realpath(values.config);
const localRoot = await realpath(path.resolve(".local"));
assert(
  stateDir.startsWith(`${localRoot}${path.sep}`),
  "Fixture must be beneath this checkout's .local",
);
assert(configPath.startsWith(`${stateDir}${path.sep}`), "Config must belong to the fixture");
const fixture: unknown = JSON.parse(
  await readFile(path.join(stateDir, "team-shape-summary.json"), "utf8"),
);
const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
assert(
  isRecord(fixture) &&
    fixture.format === "openclaw-team-shape-v1" &&
    isRecord(fixture.stressCounts),
);
assert(isRecord(config) && isRecord(config.gateway));
const gateway = config.gateway;
assert(gateway.mode === "local" && gateway.bind === "loopback");
assert(
  isRecord(gateway.auth) && gateway.auth.mode === "none",
  "Only synthetic unauthenticated fixtures are supported",
);
const port =
  values.port === undefined
    ? gateway.port
    : parseStrictIntegerOption({
        raw: values.port,
        label: "--port",
        min: 40000,
        fallback: 40000,
      });
assert(typeof port === "number" && Number.isInteger(port) && port >= 40000 && port <= 65535);
assert(Array.isArray(fixture.stressTargets) && fixture.stressTargets.length > 0);
const targets = fixture.stressTargets.map((target: unknown) => {
  assert(isRecord(target) && target.agentId === "main" && typeof target.sessionKey === "string");
  assert(target.sessionKey.startsWith("agent:main:"));
  return { key: target.sessionKey, agentId: target.agentId };
});
const integer = (name: "duration-ms" | "interval-ms") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const durationMs = integer("duration-ms");
const intervalMs = integer("interval-ms");
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
type Sample = {
  index: number;
  key: string;
  unread: boolean;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
};
const samples: Sample[] = [];
const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
let failure: string | undefined;
let startedAt: string | undefined;
let elapsedMs = 0;
const loadBefore = loadavg();
try {
  await client.waitOpen();
  const hello = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-unread-patch-probe",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    caps: [],
  });
  assert(hello.ok, `connect failed: ${JSON.stringify(hello.error)}`);
  startedAt = new Date().toISOString();
  const started = performance.now();
  for (let index = 0; performance.now() - started < durationMs; index++) {
    const target = targets[Math.floor(index / 2) % targets.length]!;
    const unread = index % 2 === 0;
    const requestStarted = performance.now();
    const sample: Sample = {
      index,
      key: target.key,
      unread,
      startedAt: new Date().toISOString(),
      endedAt: "",
      latencyMs: 0,
      ok: false,
    };
    try {
      const response = await client.request("sessions.patch", { ...target, unread }, 60_000);
      assert(response.ok, `sessions.patch failed: ${JSON.stringify(response.error)}`);
      const payload = response.payload;
      assert(isRecord(payload) && payload.key === target.key && isRecord(payload.entry));
      const entry = payload.entry;
      if (unread) {
        assert(typeof entry.markedUnreadAt === "number" && Number.isFinite(entry.markedUnreadAt));
      } else {
        assert(entry.markedUnreadAt === undefined, "Read patch retained the unread marker");
        assert(typeof entry.lastReadAt === "number" && Number.isFinite(entry.lastReadAt));
      }
      sample.ok = true;
    } catch (error) {
      sample.error = error instanceof Error ? error.message : String(error);
    }
    sample.latencyMs = performance.now() - requestStarted;
    sample.endedAt = new Date().toISOString();
    samples.push(sample);
    await delay(
      Math.max(
        0,
        Math.min(intervalMs - sample.latencyMs, durationMs - (performance.now() - started)),
      ),
    );
  }
  elapsedMs = performance.now() - started;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  client.close();
}
const latencies = samples
  .filter((sample) => sample.ok)
  .map((sample) => sample.latencyMs)
  .toSorted((a, b) => a - b);
const percentile = (fraction: number) =>
  latencies[Math.ceil(latencies.length * fraction) - 1] ?? null;
const summary = {
  format: "openclaw-session-patch-commit-probe-v1",
  stateDir,
  configPath,
  port,
  sessionCount: fixture.sessionCount,
  targetCount: targets.length,
  durationMs,
  intervalMs,
  startedAt,
  endedAt: new Date().toISOString(),
  elapsedMs,
  calls: samples.length,
  successes: latencies.length,
  errors: samples.length - latencies.length,
  callsPerSecond: elapsedMs > 0 ? samples.length / (elapsedMs / 1000) : 0,
  latencyMs: {
    count: latencies.length,
    mean: latencies.length
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
      : null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: latencies.at(-1) ?? null,
  },
  loadBefore,
  loadAfter: loadavg(),
  failure,
};
await writeFile(output, `${JSON.stringify({ ...summary, samples }, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, output }));
if (failure || summary.errors) {
  process.exitCode = 1;
}
