/**
 * Diagnostic-only synthetic Gateway payload census. Use with team-shape-stress.ts
 * --gateway-preload scripts/perf/worker-payload-census-preload.mjs. Aggregates go
 * to OPENCLAW_STATE_DIR/worker-payload-census.json; no payload values are recorded.
 * V8 serialization estimates run outside the timed native postMessage call.
 * This extra traversal perturbs the Gateway: never use this pass for latency gates.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { serialize } from "node:v8";
import { isMainThread, MessagePort } from "node:worker_threads";

if (isMainThread && process.env.OPENCLAW_STATE_DIR) {
  const output = path.join(process.env.OPENCLAW_STATE_DIR, "worker-payload-census.json");
  const totals = new Map();
  // Reflect.apply below preserves the original caller's port receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    // Task envelopes carry domain input; control/authority ports are left alone.
    const input = message?.input;
    if (typeof message?.taskId !== "number" || !input || message.responseId !== undefined) {
      return Reflect.apply(post, this, [message, ...rest]);
    }
    const kind = String(input.kind ?? input.type ?? "unclassified");
    let row = totals.get(kind);
    if (!row) {
      row = { kind, count: 0, bytes: 0, maxBytes: 0, unmeasured: 0, postCpuMicros: 0, fields: {} };
      totals.set(kind, row);
    }
    const size = (value) => {
      try {
        return serialize(value).byteLength;
      } catch {
        return undefined; // Native handles and shared buffers are not V8-serializable.
      }
    };
    const bytes = size(input);
    row.count++;
    if (bytes === undefined) {
      row.unmeasured++;
    } else {
      row.bytes += bytes;
      row.maxBytes = Math.max(row.maxBytes, bytes);
    }
    for (const key of Object.getPrototypeOf(input) === Object.prototype ? Object.keys(input) : []) {
      const fieldBytes = size(input[key]);
      if (fieldBytes !== undefined) {
        row.fields[key] = (row.fields[key] ?? 0) + fieldBytes;
      }
    }
    if (input.request && typeof input.request === "object") {
      for (const key of Object.keys(input.request)) {
        const fieldBytes = size(input.request[key]);
        if (fieldBytes !== undefined) {
          row.fields[`request.${key}`] = (row.fields[`request.${key}`] ?? 0) + fieldBytes;
        }
      }
    }
    const cpu = process.threadCpuUsage();
    try {
      return Reflect.apply(post, this, [message, ...rest]);
    } finally {
      const used = process.threadCpuUsage(cpu);
      row.postCpuMicros += used.user + used.system;
    }
  };
  const flush = () => writeFileSync(output, JSON.stringify([...totals.values()], null, 2));
  setInterval(flush, 5000).unref();
  process.on("exit", flush);
}
