// Run on the approved benchmark host with Node 26 and --import ./scripts/tsx.mjs.
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { AsyncContext } from "../../src/shared/async-context.ts";
import { runWithAsyncStore } from "../../src/shared/async-store.ts";

const [variant = "single", countText = "26", iterationsText = "200000", profilePath] =
  process.argv.slice(2);
const count = Number(countText);
const iterations = Number(iterationsText);
if (
  !["stock", "single", "consolidated", "linked", "slots"].includes(variant) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1
) {
  throw new Error(
    "Usage: async-store-measure.mjs <stock|single|consolidated|linked|slots> <stores> <iterations> [profile-path]",
  );
}

const values = Array.from({ length: 64 }, (_, index) => Object.freeze({ value: index }));
let sink = 0;

function nativeStores() {
  const stores = Array.from({ length: count + 1 }, () =>
    variant === "consolidated" ? new AsyncContext(Symbol("measured")) : new AsyncLocalStorage(),
  );
  const target = stores[count];
  const enter =
    variant === "stock" ? (storage, value, run) => storage.run(value, run) : runWithAsyncStore;
  const work = () => {
    sink += target.getStore().value;
  };
  return {
    run: (value) => enter(target, value, work),
    read: (index) => stores[index].getStore(),
    within: (run) =>
      stores
        .slice(0, count)
        .reduceRight(
          (inner, storage, index) => () => storage.run(values[index & 63], inner),
          run,
        )(),
  };
}

// Experiments only: independent scopes would need their own exit/disable contracts.
function persistentStores() {
  const carrier = new AsyncLocalStorage();
  const read =
    variant === "slots"
      ? (key) => carrier.getStore()?.[key]
      : (key) => {
          for (let node = carrier.getStore(); node; node = node.parent) {
            if (node.key === key) {
              return node.value;
            }
          }
          return undefined;
        };
  const enter = (key, value, run) => {
    if (read(key) === value) {
      return run();
    }
    let frame;
    if (variant === "slots") {
      frame = carrier.getStore()?.slice() ?? [];
      frame[key] = value;
      Object.freeze(frame);
    } else {
      frame = Object.freeze({ key, value, parent: carrier.getStore() });
    }
    return runWithAsyncStore(carrier, frame, run);
  };
  const work = () => {
    sink += read(count).value;
  };
  return {
    run: (value) => enter(count, value, work),
    read,
    within: (run) =>
      Array.from({ length: count }, (_, key) => key).reduceRight(
        (inner, key) => () => enter(key, values[key & 63], inner),
        run,
      )(),
  };
}

const stores = ["stock", "single", "consolidated"].includes(variant)
  ? nativeStores()
  : persistentStores();
await stores.within(async () => {
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.enable");
    for (let index = 0; index < 20000; index++) {
      stores.run(values[index & 63]);
    }
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let index = 0; index < iterations; index++) {
      stores.run(values[index & 63]);
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    if (profilePath) {
      writeFileSync(profilePath, JSON.stringify(profile));
    }
    const bytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    const nativeFrameNodes = new Set();
    const visit = (node, inFrame = false) => {
      const frame =
        inFrame ||
        (node.callFrame.url.includes("internal/async_context_frame") &&
          node.callFrame.functionName === "AsyncContextFrame");
      if (frame) {
        nativeFrameNodes.add(node.id);
      }
      for (const child of node.children ?? []) {
        visit(child, frame);
      }
    };
    visit(profile.head);
    const nativeFrameSamples = profile.samples.filter((sample) =>
      nativeFrameNodes.has(sample.nodeId),
    );
    // Timings are separate from the allocation profiler, whose overhead depends on bytes.
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      stores.run(values[index & 63]);
    }
    const runNs = ((performance.now() - started) * 1e6) / iterations;
    const lookups = {};
    for (const [label, key] of [
      ["oldest", 0],
      ["middle", count >> 1],
      ["newest", count - 1],
    ]) {
      for (let index = 0; index < 20000; index++) {
        sink += stores.read(key).value;
      }
      const lookupStarted = performance.now();
      for (let index = 0; index < iterations * 10; index++) {
        sink += stores.read(key).value;
      }
      lookups[label] = ((performance.now() - lookupStarted) * 1e6) / (iterations * 10);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        variant,
        stores: count,
        iterations,
        bytesPerRun: bytes / iterations,
        allocationSamples: profile.samples.length,
        nativeFrameBytesPerRun: nativeFrameSamples.length
          ? nativeFrameSamples.reduce((total, sample) => total + sample.size, 0) / iterations
          : null,
        nativeFrameAllocationSamples: nativeFrameSamples.length,
        runNs,
        getStoreNs: lookups,
        sink,
      }),
    );
  } finally {
    inspector.disconnect();
  }
});
