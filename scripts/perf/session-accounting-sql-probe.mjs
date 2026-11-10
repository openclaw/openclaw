// Separate synthetic-fixture SQL pass only; never include this preload in timings.
// --import 'file:///absolute/path/to/this.mjs?directory=/absolute/output'
// Capture actual expanded native SELECTs in every worker, then replay readonly
// with sqlite3 .stats and EXPLAIN. Output includes startup/warmup; identify the
// accounting request's statement groups before reporting per-operation bytes.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import workerThreads, { threadId } from "node:worker_threads";

const directory = new URL(import.meta.url).searchParams.get("directory");
assert(directory && path.isAbsolute(directory));
mkdirSync(directory, { recursive: true });
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.url)
        ? execArgv
        : [...execArgv, "--import", import.meta.url],
    });
  }
};
syncBuiltinESMExports();
const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
assert(prepareDescriptor?.value);
const prepare = prepareDescriptor.value;
DatabaseSync.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  for (const method of ["all", "get", "iterate"]) {
    const call = statement[method].bind(statement);
    statement[method] = function (...bindings) {
      const value = call(...bindings);
      if (
        /^\s*(?:SELECT|WITH)\b/i.test(statement.sourceSQL) &&
        /\b(?:transcript_events|session_transcript_active_events)\b/.test(statement.sourceSQL)
      ) {
        appendFileSync(
          path.join(directory, `worker-${process.pid}-${threadId}.jsonl`),
          JSON.stringify({ at: Date.now(), sql: statement.expandedSQL }) + "\n",
        );
      }
      return value;
    };
  }
  return statement;
};
