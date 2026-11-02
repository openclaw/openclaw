/**
 * Synthetic Gateway diagnostic, main isolate only. Add to team-shape-stress.ts:
 * --minutes 30 --mode timing --gateway-preload scripts/perf/main-code-space-preload.mjs
 * Writes minute V8 code/heap statistics and cumulative dynamic-compiler counts
 * to the isolated OPENCLAW_STATE_DIR/code-census.jsonl. Caller/source cardinality
 * is bounded; source text is hashed, never persisted. Stack capture adds overhead,
 * so these runs attribute compilation and retention, not timing acceptance.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { getHeapCodeStatistics, getHeapSpaceStatistics } from "node:v8";
import vm from "node:vm";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  const output = join(process.env.OPENCLAW_STATE_DIR, "code-census.jsonl");
  const started = Date.now();
  const counts = new Map();
  let dropped = 0;
  function count(kind, args) {
    const stack = new Error().stack?.split("\n").slice(3, 10).join("\n") ?? "";
    const source = args.filter((x) => typeof x === "string").join("\n");
    const hash = createHash("sha256").update(source).digest("hex");
    const key = kind + "\n" + stack;
    let entry = counts.get(key);
    if (!entry) {
      if (counts.size >= 128) {
        dropped++;
        return;
      }
      entry = { kind, stack, calls: 0, sourceBytes: 0, hashes: new Set() };
      counts.set(key, entry);
    }
    entry.calls++;
    entry.sourceBytes += Buffer.byteLength(source);
    if (entry.hashes.size < 512) {
      entry.hashes.add(hash);
    }
  }
  function wrap(target, kind) {
    return new Proxy(target, {
      apply(fn, receiver, args) {
        count(kind, args);
        return Reflect.apply(fn, receiver, args);
      },
      construct(fn, args, newTarget) {
        count(kind, args);
        return Reflect.construct(fn, args, newTarget);
      },
    });
  }
  globalThis.Function = wrap(globalThis.Function, "Function");
  vm.Script = wrap(vm.Script, "vm.Script");
  for (const name of ["compileFunction", "runInContext", "runInNewContext", "runInThisContext"]) {
    vm[name] = wrap(vm[name], name);
  }
  syncBuiltinESMExports();
  function sample() {
    appendFileSync(
      output,
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        elapsedMs: Date.now() - started,
        code: getHeapCodeStatistics(),
        spaces: getHeapSpaceStatistics().filter((s) => s.space_name.includes("code")),
        memory: process.memoryUsage(),
        dropped,
        compilers: [...counts.values()].map(({ hashes, kind, stack, calls, sourceBytes }) => ({
          kind,
          stack,
          calls,
          sourceBytes,
          distinctSources: hashes.size,
        })),
      }) + "\n",
    );
  }
  sample();
  setInterval(sample, 60000).unref();
  process.once("exit", sample);
}
