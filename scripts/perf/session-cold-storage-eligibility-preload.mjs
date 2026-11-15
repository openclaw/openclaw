// Native work observation only; loaded explicitly by the opt-in maintenance workload.
import { appendFileSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { threadId, isMainThread } from "node:worker_threads";
const output = process.env.OPENCLAW_COLD_ELIGIBILITY_COUNTS;
if (output) {
  Error.stackTraceLimit = 60;
  for (const method of ["all", "get", "iterate"]) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function (...args) {
      const sql = this.sourceSQL;
      const stack = new Error().stack;
      const eligibility = stack.includes("readSessionColdStorageProtection");
      const admission = stack.includes("readSessionAdmissionProtectionKeys");
      const externalization =
        /select .*session_id.*from "session_transcript_cold_archives" where "storage".*order by/.test(
          sql,
        );
      if (!eligibility && !admission && !externalization) {
        return Reflect.apply(original, this, args);
      }
      const phase = eligibility
        ? stack.includes("mutateSessionColdTranscriptInWorker")
          ? "mutation"
          : "selection"
        : admission
          ? "admission"
          : "externalization-selection";
      const record = {
        pid: process.pid,
        threadId,
        isMainThread,
        phase,
        table: /from "([^" ]+)/.exec(sql)?.[1],
        calls: 1,
        rows: 0,
        entryBytes: 0,
      };
      const row = (value) => {
        record.rows++;
        if (typeof value?.entry_json === "string") {
          record.entryBytes += Buffer.byteLength(value.entry_json);
        }
      };
      const emit = () => appendFileSync(output, JSON.stringify(record) + "\n");
      const result = Reflect.apply(original, this, args);
      if (method === "iterate") {
        return (function* () {
          try {
            for (const value of result) {
              row(value);
              yield value;
            }
          } finally {
            emit();
          }
        })();
      }
      if (method === "all") {
        result.forEach(row);
      } else if (result) {
        row(result);
      }
      emit();
      return result;
    };
  }
}
