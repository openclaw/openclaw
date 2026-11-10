/**
 * Compare 12 unchanged five-second RPCs with one 12-window capture on an isolated
 * Node 24.22.1 dist Gateway, after transcript-broadcast-measure.ts warmup. Launch
 * that Gateway with --gateway-preload scripts/perf/diagnostic-cpu-profile-measure-preload.mjs.
 * node --import ./scripts/tsx.mjs scripts/perf/diagnostic-cpu-profile-measure.mts \
 *   --url ws://127.0.0.1:42358 --output .local/cpu-batch.jsonl --pairs 5 --aa-sets 2
 * The Gateway must use synthetic state and loopback auth=none; never target a live Gateway.
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "ws://127.0.0.1:42358" },
    output: { type: "string" },
    pairs: { type: "string", default: "5" },
    windows: { type: "string", default: "12" },
    "aa-sets": { type: "string", default: "2" },
    "settle-ms": { type: "string", default: "30000" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const pairs = integer(values.pairs, "--pairs");
const windows = integer(values.windows, "--windows");
const aaSets = integer(values["aa-sets"], "--aa-sets", 0);
const settleMs = integer(values["settle-ms"], "--settle-ms", 0);
const url = new URL(values.url);
assert.equal(url.protocol, "ws:");
assert.equal(url.hostname, "127.0.0.1", "Only the isolated loopback fixture is supported");
assert.ok(values.output, "--output is required");
assert.ok(windows <= 30, "--windows must be <= 30");
const output = values.output;
writeFileSync(output, "", { flag: "wx" });
const record = (row: unknown) => {
  const json = JSON.stringify(row);
  appendFileSync(output, `${json}\n`);
  console.log(json);
};
const telemetry = async (action: "start" | "stop") => {
  const response = await fetch(`http://127.0.0.1:42360/${action}`, { method: "POST" });
  assert.ok(response.ok, "Benchmark telemetry listener unavailable");
  const result: unknown = await response.json();
  assert.ok(isRecord(result));
  assert.equal(result.node, "v24.22.1", "Use the target runtime for this comparison");
  return result;
};
const client = createGatewayWsClient({
  url: values.url,
  handshakeTimeoutMs: 60_000,
  openTimeoutMs: 60_000,
});

async function capture(batch: boolean, checkBusy: boolean) {
  const params = batch ? { windows, windowMs: 5_000 } : {};
  const pending = client.request(
    "diagnostics.cpuProfile",
    params,
    (batch ? windows : 1) * 5_000 + 30_000,
  );
  let concurrent;
  if (checkBusy) {
    await delay(100);
    concurrent = await client.request("diagnostics.cpuProfile", {}, 60_000);
    assert.equal(concurrent.ok, false);
    assert.ok(isRecord(concurrent.error) && isRecord(concurrent.error.details));
    assert.equal(concurrent.error.details.reason, "busy");
  }
  const response = await pending;
  assert.ok(response.ok, JSON.stringify(response.error));
  const result = response.payload;
  assert.ok(
    isRecord(result) && isRecord(result.profile),
    "A full profile is required for this proof",
  );
  const responseBytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(responseBytes <= 1024 * 1024, "Profile response exceeds the 1 MiB contract");
  assert.equal(result.requestedDurationMs, (batch ? windows : 1) * 5_000);
  const profile = result.profile;
  assert.ok(
    Array.isArray(profile.nodes) &&
      Array.isArray(profile.samples) &&
      Array.isArray(profile.timeDeltas),
  );
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  assert.ok(profile.samples.length > 0);
  assert.ok(typeof profile.startTime === "number" && typeof profile.endTime === "number");
  assert.ok(profile.endTime > profile.startTime);
  const boundaries = batch ? result.windowBoundariesMicros : [profile.startTime, profile.endTime];
  assert.ok(Array.isArray(boundaries));
  assert.equal(boundaries.length, batch ? windows + 1 : 2);
  assert.equal(boundaries[0], profile.startTime);
  assert.equal(boundaries.at(-1), profile.endTime);
  for (let index = 1; index < boundaries.length; index++) {
    assert.ok(typeof boundaries[index] === "number" && boundaries[index] > boundaries[index - 1]);
    if (batch && index < windows) {
      assert.equal(boundaries[index], profile.startTime + index * 5_000_000);
    }
  }
  if (!batch) {
    assert.equal(result.windowBoundariesMicros, undefined);
  }
  const windowSamples = Array.from({ length: boundaries.length - 1 }, () => 0);
  const ids = new Set(
    profile.nodes.map((node: unknown) => {
      assert.ok(isRecord(node) && typeof node.id === "number");
      return node.id;
    }),
  );
  let lastTimestamp = profile.startTime;
  for (let index = 0; index < profile.samples.length; index++) {
    assert.ok(ids.has(profile.samples[index]), "A sample must reference a returned node");
    const delta: unknown = profile.timeDeltas[index];
    assert.ok(typeof delta === "number" && Number.isFinite(delta));
    lastTimestamp += delta;
    assert.ok(lastTimestamp >= profile.startTime && lastTimestamp <= profile.endTime);
    // Signed deltas can move backward; partition each timestamp independently.
    let window = 0;
    while (window < windowSamples.length - 1 && lastTimestamp >= boundaries[window + 1]) {
      window++;
    }
    windowSamples[window]!++;
  }
  assert.equal(
    windowSamples.reduce((sum, count) => sum + count, 0),
    profile.samples.length,
  );
  assert.ok(typeof result.startBlockedMs === "number");
  return {
    startBlockedMs: result.startBlockedMs,
    actualDurationMs: result.actualDurationMs,
    requestedDurationMs: result.requestedDurationMs,
    profileStartTime: profile.startTime,
    profileEndTime: profile.endTime,
    lastSampleTimestamp: lastTimestamp,
    samples: profile.samples.length,
    nodes: profile.nodes.length,
    responseBytes,
    windowBoundariesMicros: boundaries,
    windowSamples,
    concurrentBusy: concurrent !== undefined,
  };
}

async function measure(arm: "single" | "batch", pair: number, control = false) {
  const before = await telemetry("start");
  const captures = [];
  const started = performance.now();
  for (let index = 0; index < (arm === "batch" ? 1 : windows); index++) {
    captures.push(await capture(arm === "batch", index === 0));
  }
  // Let the heartbeat observe the final synchronous stop/serialization before ending telemetry.
  await delay(20);
  const after = await telemetry("stop");
  assert.ok(Array.isArray(after.starts));
  assert.equal(after.starts.length, arm === "batch" ? 1 : windows);
  assert.equal(after.stops, arm === "batch" ? 1 : windows);
  record({
    kind: control ? "aa" : "comparison",
    pair,
    arm,
    windows,
    windowMs: 5_000,
    wallMs: performance.now() - started,
    startBlockedMs: captures.reduce((sum, result) => sum + result.startBlockedMs, 0),
    before,
    after,
    captures,
  });
}

try {
  await client.waitOpen();
  const hello = await client.request(
    "connect",
    {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "synthetic-cpu-batch-measurement",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.admin"],
      caps: [],
    },
    60_000,
  );
  assert.ok(hello.ok, JSON.stringify(hello.error));
  await delay(settleMs);
  for (let pair = 0; pair < pairs; pair++) {
    const arms: ("single" | "batch")[] = pair % 2 ? ["batch", "single"] : ["single", "batch"];
    for (const arm of arms) {
      await measure(arm, pair);
    }
  }
  for (let pair = 0; pair < aaSets; pair++) {
    await measure("single", pair, true);
  }
} finally {
  client.close();
}
