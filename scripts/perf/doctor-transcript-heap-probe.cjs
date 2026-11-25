// Benchmark-only observation. No bindings or transcript contents are recorded.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getHeapStatistics } = require("node:v8");
const { threadId, isMainThread } = require("node:worker_threads");
const { loadavg } = require("node:os");
const root = process.env.OPENCLAW_BENCH_DOCTOR_HEAP_OUTPUT;
if (!root) {
  throw new Error("Missing benchmark output directory");
}
const fd = fs.openSync(path.join(root, `heap-${process.pid}-${threadId}.jsonl`), "wx", 0o600);
let peakHeap = 0;
let peakExternal = 0;
let calls = 0;
let active;
let serial = 0;
function sample() {
  const heap = getHeapStatistics();
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, heap.used_heap_size);
  peakExternal = Math.max(peakExternal, memory.external);
  return {
    elapsedMs: performance.now(),
    heapUsed: heap.used_heap_size,
    heapLimit: heap.heap_size_limit,
    allocatedBytes: heap.total_allocated_bytes,
    external: memory.external,
    rss: memory.rss,
    peakHeap,
    peakExternal,
    threadCpu: process.threadCpuUsage(),
    processCpu: isMainThread ? process.cpuUsage() : undefined,
  };
}
function record(event) {
  fs.writeSync(
    fd,
    JSON.stringify({ pid: process.pid, threadId, calls, ...sample(), ...event }) + "\n",
  );
}
record({ kind: "start", version: process.version, load: loadavg() });
// oxlint-disable-next-line typescript/unbound-method -- Forwarded with the native database receiver.
const nativeFunction = DatabaseSync.prototype.function;
DatabaseSync.prototype.function = function (name, ...args) {
  const callback = args.pop();
  if (!name.includes("decode")) {
    return nativeFunction.call(this, name, ...args, callback);
  }
  let localCalls = 0;
  record({ kind: "udf-registration", name, stack: new Error().stack });
  const wrapped = function (...values) {
    ++calls;
    ++localCalls;
    if ((localCalls & 63) === 1) {
      record({ kind: "udf-sample", name, localCalls, calls, query: active?.id });
    }
    return Reflect.apply(callback, this, values);
  };
  // SQLite derives the SQL arity from Function.length.
  Object.defineProperty(wrapped, "length", { value: callback.length });
  return nativeFunction.call(this, name, ...args, wrapped);
};
// oxlint-disable-next-line typescript/unbound-method -- Forwarded with the native database receiver.
const nativePrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = nativePrepare.call(this, sql);
  if (!sql.includes("decode")) {
    return statement;
  }
  const id = ++serial;
  record({ kind: "query-prepared", id, sql, stack: new Error().stack });
  for (const method of ["all", "get", "run"]) {
    const original = statement[method];
    statement[method] = function (...args) {
      const previous = active;
      active = { id, method };
      record({ kind: "query-start", id, method });
      try {
        const result = Reflect.apply(original, this, args);
        record({
          kind: "query-end",
          id,
          method,
          rows: Array.isArray(result) ? result.length : undefined,
        });
        return result;
      } finally {
        active = previous;
      }
    };
  }
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the native statement receiver.
  const originalIterate = statement.iterate;
  statement.iterate = function (...args) {
    const iterator = Reflect.apply(originalIterate, this, args);
    const next = iterator.next;
    let rows = 0;
    const context = { id, method: "next" };
    record({ kind: "query-start", id, method: "iterate" });
    iterator.next = function () {
      const previous = active;
      active = context;
      try {
        const result = next.call(this);
        if (result.done) {
          record({ kind: "query-end", id, method: "iterate", rows });
        } else {
          rows++;
        }
        return result;
      } finally {
        active = previous;
      }
    };
    return iterator;
  };
  return statement;
};
const timer = setInterval(() => record({ kind: "timer", calls }), 1000).unref();
process.once("exit", (code) => {
  clearInterval(timer);
  record({ kind: "exit", code, calls, load: loadavg() });
  fs.closeSync(fd);
});
