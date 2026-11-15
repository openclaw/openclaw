// Synthetic, isolated Gateways only: records source filenames and stacks.
// OPENCLAW_BENCH_PLUGIN_TRANSFORM_TRACE=/absolute/trace.jsonl node --expose-gc \
//   --import ./scripts/perf/plugin-transform-preload.mjs dist/entry.js gateway run --port 41680
// Each 15-second main-isolate sample forces GC. This is retention/attribution proof,
// not an untraced CPU, GC or latency benchmark. Worker rows identify relocated work.
import { appendFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_PLUGIN_TRANSFORM_TRACE;
if (!output || !path.isAbsolute(output)) {
  throw new Error("Set OPENCLAW_BENCH_PLUGIN_TRANSFORM_TRACE to an absolute output file");
}
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below preserves each requiring module as the receiver.
const original = Module.prototype.require;
const wrapped = new WeakMap();
const require = createRequire(import.meta.url);
function record(data) {
  appendFileSync(
    output,
    JSON.stringify({ pid: process.pid, threadId, isMainThread, ...data }) + "\n",
  );
}
record({ kind: "start" });
Module.prototype.require = function (request) {
  const loaded = Reflect.apply(original, this, [request]);
  if (request.endsWith("babel.cjs") && /[/\\]jiti[/\\]/u.test(this.filename ?? "")) {
    if (!wrapped.has(loaded)) {
      record({ kind: "babel-load", parent: this.filename, stack: new Error().stack });
      wrapped.set(
        loaded,
        new Proxy(loaded, {
          apply(target, receiver, args) {
            record({ kind: "transform", filename: args[0]?.filename, stack: new Error().stack });
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    }
    return wrapped.get(loaded);
  }
  return loaded;
};
if (isMainThread) {
  setInterval(() => {
    global.gc?.();
    record({
      kind: "memory",
      memory: process.memoryUsage(),
      babel: Object.keys(require.cache).filter((filename) => /jiti.*babel\.cjs$/u.test(filename)),
    });
  }, 15_000).unref();
}
