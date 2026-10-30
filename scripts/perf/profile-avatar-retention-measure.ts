/**
 * Profile avatar owner retention and warm-read probe using synthetic SQLite state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/profile-avatar-retention-measure.ts
 *   [--owner /absolute/saved/user-profiles-avatar.ts] [--iterations 3000]
 *   [--allocations] [--snapshot .local/avatar.heapsnapshot]
 *
 * Forty 512 KiB uploads overflow the 16 MiB cache while callers keep currency
 * closures. Eight evicted payloads must become collectible; the other 32 remain
 * warm. Time/allocation cover only warm owner calls, not setup or heap capture.
 * Alternate base/candidate timing passes and separate sampled-allocation passes.
 * Acceptance: identical bytes/current checks, 4 MiB less retained backing storage,
 * preserved warm payload identity. This is owner proof, not whole-Gateway throughput proof.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
    snapshot: { type: "string" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3000,
  min: 1,
  label: "iterations",
});
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/profile-avatar-probe-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{"plugins":{"enabled":false}}');
const options = { path: path.join(root, "openclaw.sqlite") };
const ownerUrl = new URL("../../src/state/user-profiles-avatar.ts", import.meta.url).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setAvatar } = await import("../../src/state/user-profile-writes.worker.js");
const { prepareUserProfileCatalog } = await import("../../src/state/user-profile-list.js");
const { createProfileAvatarReader } = await import("../../src/state/user-profiles-avatar.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
assert(!values.owner || wasOwnerReplaced(), "Baseline owner was not substituted");
const inspector = new Session();
const payloadBytes = 512 * 1024;
let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
try {
  const profiles = Array.from({ length: 40 }, (_, index) => {
    const profile = ensureProfileForEmail(`avatar-${index}@example.test`, options);
    assert(
      setAvatar(profile.id, new Uint8Array(payloadBytes).fill(index), "image/png", options).ok,
    );
    return profile;
  });
  catalog = await prepareUserProfileCatalog(options);
  const retained: Array<{
    isCurrent: () => boolean;
    ref: WeakRef<Uint8Array>;
    backingBytes: number;
  }> = [];
  for (const [index, profile] of profiles.entries()) {
    const prepared = await createProfileAvatarReader(profile.id, options).inspect();
    const result = await prepared.loadBytes();
    assert(result);
    assert.equal(result.bytes.byteLength, payloadBytes);
    assert.equal(result.bytes[0], index);
    retained.push({
      // Retain the currency closure without retaining its prepared receiver.
      isCurrent: prepared.isCurrent.bind(undefined),
      ref: new WeakRef(result.bytes),
      backingBytes: result.bytes.buffer.byteLength,
    });
  }
  async function warm(count: number) {
    for (let index = 0; index < count; index++) {
      const offset = 8 + (index % 32);
      const prepared = await createProfileAvatarReader(profiles[offset]!.id, options).inspect();
      const result = await prepared.loadBytes();
      assert(prepared.isCurrent());
      assert.equal(
        result?.bytes,
        retained[offset]!.ref.deref(),
        "Warm reads must reuse the payload",
      );
      assert.equal(result?.bytes[0], offset);
    }
  }
  await warm(320);
  for (let index = 0; index < 5; index++) {
    await nextTurn();
    globalThis.gc();
  }
  const retainedBefore = process.memoryUsage();
  const live = retained.map((entry) => ({
    current: entry.isCurrent(),
    bytes: entry.ref.deref() ? entry.backingBytes : 0,
  }));
  assert(live.every((entry) => entry.current));
  const retainedBackingBytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
  const evictedBackingBytes = live.slice(0, 8).reduce((sum, entry) => sum + entry.bytes, 0);
  if (values.snapshot) {
    mkdirSync(path.dirname(path.resolve(values.snapshot)), { recursive: true });
    writeHeapSnapshot(values.snapshot);
  }
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await warm(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const allocatedBytes = values.allocations
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      owner: values.owner ?? "candidate",
      mode: values.allocations ? "allocation" : "timing",
      iterations,
      cpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      retainedBackingBytes,
      evictedBackingBytes,
      retainedBefore,
      memoryAfter: process.memoryUsage(),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
  catalog?.release();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  rmSync(root, { recursive: true, force: true });
}
