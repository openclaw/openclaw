/**
 * Actual authenticated sandbox browser bridges under synthetic preparation scopes.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-browser-context-retention.ts \
 *   --owner /path/to/frozen/http-listen.ts --measure timing --count 50
 * Repeat five counterbalanced pairs and unchanged A/A controls. Run allocation
 * separately: Inspector records main-isolate inclusive allocation, not retained bytes.
 * Each scope owns a labeled 1 MiB numeric array, allocated outside measured work.
 * This scaled ownership fixture does not establish production bytes per sandbox;
 * no database, workspace scan, Chromium process, or user profile is involved.
 * Require every retired scope to collect while its authenticated bridge still works.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    count: { type: "string", default: "50" },
    measure: { type: "string", default: "timing" },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values.measure === "timing" || values.measure === "allocation");
const count = parseStrictIntegerOption({
  raw: values.count,
  label: "--count",
  min: 1,
  fallback: 50,
});
const ownerUrl = new URL("../../extensions/browser/src/browser/http-listen.ts", import.meta.url);
const ownerFile = values.owner ?? fileURLToPath(ownerUrl);
const ownerSha256 = createHash("sha256").update(readFileSync(ownerFile)).digest("hex");
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values.owner);
const { startBrowserBridgeServer, stopBrowserBridgeServer } =
  await import("../../extensions/browser/bridge-api.ts");
const { resolveBrowserConfig } = await import("../../extensions/browser/benchmark-api.ts");

type Bridge = Awaited<ReturnType<typeof startBrowserBridgeServer>>;
type Preparation = { label: string; payload: number[] };
const scopes = new AsyncLocalStorage<Preparation>();
const bridges: Bridge[] = [];
const witnesses: WeakRef<Preparation>[] = [];
const pending: Array<Preparation | undefined> = [];
const markerBytes = 1024 * 1024;
const token = "synthetic-browser-context-retention";
const inspector = new Session();
let sampling = false;
function options() {
  return {
    resolved: {
      ...resolveBrowserConfig({
        evaluateEnabled: false,
        attachOnly: true,
        defaultProfile: "openclaw",
        profiles: { openclaw: { cdpPort: 1 } },
      }),
      controlPort: 0,
    },
    authToken: token,
  };
}
async function quietGc() {
  for (let round = 0; round < 5; round++) {
    await setTimeout(100);
    global.gc!();
  }
}
function heap() {
  return {
    oldGenerationBytes: getHeapSpaceStatistics()
      .filter(
        (space) => space.space_name === "old_space" || space.space_name === "large_object_space",
      )
      .reduce((total, space) => total + space.space_used_size, 0),
    heapUsedBytes: process.memoryUsage().heapUsed,
  };
}
function alive() {
  return witnesses.filter((witness) => witness.deref() !== undefined).length;
}
function prepareScopes() {
  for (let index = 0; index < count; index++) {
    const preparation = {
      label: `synthetic-sandbox-preparation-${index}`,
      payload: Array.from({ length: markerBytes / 8 }, (_, offset) => index + offset),
    };
    witnesses.push(new WeakRef(preparation));
    pending.push(preparation);
  }
}
async function open(index: number) {
  const preparation = pending[index];
  assert(preparation);
  pending[index] = undefined;
  bridges.push(await scopes.run(preparation, () => startBrowserBridgeServer(options())));
}
async function openAll() {
  for (let index = 0; index < count; index++) {
    await open(index);
  }
}
async function verify() {
  for (const bridge of bridges) {
    const url = `${bridge.baseUrl}/?profile=__retention_probe_missing__`;
    const unauthenticated = await fetch(url, { headers: { Connection: "close" } });
    await unauthenticated.arrayBuffer();
    assert.equal(unauthenticated.status, 401);
    const authenticated = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Connection: "close" },
    });
    await authenticated.arrayBuffer();
    assert.equal(authenticated.status, 404);
  }
}
async function close() {
  for (const bridge of bridges) {
    await stopBrowserBridgeServer(bridge.server);
  }
  bridges.length = 0;
}
try {
  const warm = await startBrowserBridgeServer(options());
  await stopBrowserBridgeServer(warm.server);
  assert(!values.owner || replaced(), "Selected frozen HTTP owner was not loaded");
  await quietGc();
  const before = heap();
  prepareScopes();
  const loadBefore = loadavg();
  if (values.measure === "allocation") {
    await startCollectedHeapSampling(inspector, 16_384);
    sampling = true;
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  await openAll();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const threadUsed = process.threadCpuUsage(thread);
  let sampledAllocationBytes: number | undefined;
  if (sampling) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampling = false;
    sampledAllocationBytes = sumSampledHeapBytes(profile.head);
  }
  // Verify current request authentication after preparation scopes have returned.
  await verify();
  await quietGc();
  const listening = heap();
  const retainedPreparations = alive();
  await close();
  await quietGc();
  const closed = heap();
  console.log(
    JSON.stringify({
      ownerFile,
      ownerSha256,
      measure: values.measure,
      count,
      markerBytes,
      loadBefore,
      loadAfter: loadavg(),
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
      sampledAllocationBytes,
      before,
      listening,
      closed,
      retainedPreparations,
      closedPreparations: alive(),
      retainedBytesPerSandbox: (listening.oldGenerationBytes - before.oldGenerationBytes) / count,
      authenticatedRequests: count,
      rejectedUnauthenticatedRequests: count,
    }),
  );
} finally {
  if (sampling) {
    await inspector.post("HeapProfiler.stopSampling");
  }
  inspector.disconnect();
  await close();
}
