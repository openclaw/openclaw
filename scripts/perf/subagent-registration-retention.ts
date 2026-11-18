/**
 * Registry authority retention beneath subagent sessionFacts.followRegistration.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-registration-retention.ts \
 *   --mode retention --output .local/registration/candidate.json [--expect-released]
 * Repeat fresh processes with --mode cpu and --mode allocation --iterations 3000.
 * --source-dir <sparse-baseline-root> replaces the registry owner with saved source;
 * unchanged dependencies continue to resolve from this checkout. Alternate base
 * and candidate launches. Setup, forced GC, and assertions are outside CPU timing;
 * allocation sampling is a separate pass and includes objects collected by GC.
 *
 * Acceptance: ordinary Gateway callbacks release their unrelated caller context while the
 * lazy read handle still retains its required context. Registration following and
 * refusal of skipped receipts must remain identical. Neutral CPU/allocation is
 * acceptable for this capture-only repair. This measures the real registry owner
 * with a synthetic 10k-session/40-plugin caller context, not Gateway traffic/RSS.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { hash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "retention" },
    output: { type: "string" },
    "source-dir": { type: "string" },
    iterations: { type: "string", default: "3000" },
    contexts: { type: "string", default: "4" },
    "expect-released": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(["retention", "cpu", "allocation"].includes(values.mode), "Invalid --mode");
assert(global.gc, "Run with --expose-gc");
const gc = global.gc;
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const contextCount = parseStrictIntegerOption({
  raw: values.contexts,
  label: "--contexts",
  min: 1,
  fallback: 4,
});
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const fixtureRoot = await mkdtemp(path.join(path.dirname(output), "registration-state-"));
process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(fixtureRoot, "config.json");
const ownerUrl = new URL("../../src/state/openclaw-agent-db-registry-listing.ts", import.meta.url);
const sourceFile = values["source-dir"]
  ? path.resolve(values["source-dir"], "src/state/openclaw-agent-db-registry-listing.ts")
  : fileURLToPath(ownerUrl);
let overrideLoaded = false;
if (values["source-dir"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      overrideLoaded = true;
      const loaded = nextLoad(pathToFileURL(sourceFile).href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead: prepare,
  invalidateRegisteredAgentDatabasesMemo: invalidate,
} = await import("../../src/state/openclaw-agent-db-registry-listing.js");
assert(!values["source-dir"] || overrideLoaded, "Requested baseline source was not loaded");
type Authority = Pick<ReturnType<typeof prepare>, "assertCurrent" | "followRegistration">;
const options = { path: path.join(fixtureRoot, "state", "state.sqlite") };
const scope = new AsyncLocalStorage<object>();
const authorities: Authority[] = [];
const payloads: WeakRef<object>[] = [];
const gcControl = new WeakRef({ unowned: true });
let lazyReader: ReturnType<typeof prepare> | undefined;
let lazyPayload: WeakRef<object> | undefined;
const hostLoadBefore = loadavg();

function fixture() {
  return {
    sessions: Array.from({ length: 10_000 }, (_, index) => ({
      sessionId: `synthetic-session-${index}`,
      kind: index % 10 ? "finished-subagent" : "archived-dashboard",
      summary: randomBytes(2304).toString("base64"),
    })),
    plugins: Array.from({ length: 40 }, (_, index) => ({
      id: `synthetic-plugin-${index}`,
      config: { enabled: true },
    })),
  };
}
function capture(retainRead = false) {
  const payload = fixture();
  const owner = scope.run(payload, () => prepare(options, () => true));
  if (retainRead) {
    lazyPayload = new WeakRef(payload);
    lazyReader = owner;
  } else {
    payloads.push(new WeakRef(payload));
    authorities.push({
      assertCurrent: owner.assertCurrent,
      followRegistration: owner.followRegistration,
    });
  }
}
async function collect() {
  for (let index = 0; index < 5; index++) {
    await yieldToEventLoop();
    gc();
  }
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
function verifyAuthorities() {
  for (const authority of authorities) {
    authority.assertCurrent();
  }
  const change = invalidate(options);
  assert(change);
  for (const authority of authorities) {
    authority.followRegistration(change);
    authority.assertCurrent();
  }
  invalidate(options);
  const skipped = invalidate(options);
  assert(skipped);
  for (const authority of authorities) {
    assert.throws(() => authority.followRegistration(skipped), /invalidated registry/);
    assert.throws(authority.assertCurrent, /registry changed/);
  }
}

try {
  let measurement: object;
  if (values.mode === "retention") {
    // A retained read is the positive control: its original scope is still needed.
    capture(true);
    for (let index = 0; index < contextCount; index++) {
      capture();
    }
    await collect();
    const retainedMemory = process.memoryUsage();
    const survivors = payloads.filter((reference) => reference.deref() !== undefined).length;
    assert.equal(gcControl.deref(), undefined, "Unowned GC control was not collected");
    assert(lazyReader && lazyPayload?.deref(), "Lazy read lost its required caller context");
    verifyAuthorities();
    authorities.length = 0;
    await collect();
    const releasedMemory = process.memoryUsage();
    assert(payloads.every((reference) => reference.deref() === undefined));
    lazyReader = undefined;
    await collect();
    assert.equal(lazyPayload?.deref(), undefined, "Discarded read still retained caller context");
    measurement = {
      iterations: contextCount,
      survivingPayloads: survivors,
      payloadBytesPerContext: 10_000 * 3072,
      retainedPayloadBytes: survivors * 10_000 * 3072,
      retainedHeapBytes: retainedMemory.heapUsed - releasedMemory.heapUsed,
      retainedMemory,
      releasedMemory,
      lazyReaderControl: "retained while read held; released after discard",
    };
    if (values["expect-released"]) {
      assert.equal(survivors, 0, "Registration authority retained unrelated caller contexts");
    }
  } else {
    const payload = fixture();
    for (let index = 0; index < 100; index++) {
      scope.run(payload, () => prepare(options, () => true).assertCurrent());
    }
    await collect();
    const inspector = values.mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    let allocationBytes: number | undefined;
    let elapsedMs: number;
    let cpuUs: number;
    try {
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      scope.run(payload, () => {
        for (let index = 0; index < iterations; index++) {
          const owner = prepare(options, () => true);
          owner.assertCurrent();
          authorities.push({
            assertCurrent: owner.assertCurrent,
            followRegistration: owner.followRegistration,
          });
        }
      });
      elapsedMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      cpuUs = used.user + used.system;
      if (inspector) {
        allocationBytes = sampledBytes(
          (await inspector.post("HeapProfiler.stopSampling")).profile.head,
        );
      }
    } finally {
      inspector?.disconnect();
    }
    verifyAuthorities();
    measurement = {
      iterations,
      elapsedMs,
      cpuMs: cpuUs / 1000,
      cpuUsPerIteration: cpuUs / iterations,
      ...(allocationBytes !== undefined
        ? {
            sampledAllocationBytes: allocationBytes,
            sampledBytesPerIteration: allocationBytes / iterations,
            samplingInterval: 4096,
          }
        : {}),
    };
  }
  const result = {
    scope: "Real registry owner; synthetic caller context; no Gateway workload",
    mode: values.mode,
    node: process.version,
    sourceSha256: hash("sha256", readFileSync(sourceFile), "hex"),
    sessionsPerContext: 10_000,
    pluginsPerContext: 40,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    ...measurement,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  authorities.length = 0;
  scope.disable();
  await rm(fixtureRoot, { recursive: true, force: true });
}
