// Synthetic Gateway proof only. The driver arms a bounded COMMIT delay after boot.
// NODE_OPTIONS forwards this preload to the existing SQLite workers as well as MAIN.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";

const state = process.env.OPENCLAW_STATE_DIR;
if (!state) {
  throw new Error("The storage-delay proof requires isolated OPENCLAW_STATE_DIR");
}
const control = path.join(state, "benchmark-commit-delay.json");
const output = path.join(state, `benchmark-commits.${threadId}.jsonl`);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const exec = Function.prototype.call.bind(DatabaseSync.prototype.exec);
DatabaseSync.prototype.exec = function (sql) {
  let settings;
  if (/^\s*COMMIT(?:\s+TRANSACTION)?\s*;?\s*$/iu.test(sql) && this.isTransaction) {
    try {
      settings = JSON.parse(readFileSync(control, "utf8"));
    } catch {
      // No armed measurement during startup or shutdown.
    }
  }
  if (!settings) {
    return exec(this, sql);
  }
  const { delayMs, sample } = settings;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error("Invalid synthetic COMMIT delay");
  }
  const startedAt = Date.now();
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack;
  Error.stackTraceLimit = stackLimit;
  Atomics.wait(sleeper, 0, 0, delayMs);
  try {
    return exec(this, sql);
  } finally {
    appendFileSync(
      output,
      JSON.stringify({ sample, threadId, startedAt, endedAt: Date.now(), delayMs, stack }) + "\n",
    );
  }
};
