import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { vi } from "vitest";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";

/** Install the real fault only after the original worker has admitted and bound its database. */
export function failMemoryEntryOriginWrites(params: {
  agentId: string;
  trigger: "reject_diary_origin" | "fail_origin_reservation";
  createSql: string;
}): () => void {
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
  const restoreRuns: Array<() => void> = [];
  const opener = vi
    .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore")
    .mockImplementation(async (...args) => {
      const [options, source, entrypoint] = args;
      const selected =
        options.agentId === params.agentId &&
        entrypoint.moduleUrl.href ===
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href;
      if (!selected) {
        return await open(...args);
      }
      assert(source instanceof DatabaseSync, "Origin fixture requires its real native source");
      const worker = await open(...args);
      const run = worker.run.bind(worker);
      const observedRun = vi.spyOn(worker, "run").mockImplementation((operation, assertCurrent) =>
        run(async (scope) => {
          source.exec(params.createSql);
          try {
            return await operation(scope);
          } finally {
            source.exec(`DROP TRIGGER ${params.trigger}`);
          }
        }, assertCurrent),
      );
      restoreRuns.push(() => observedRun.mockRestore());
      return worker;
    });
  return () => {
    opener.mockRestore();
    for (const restore of restoreRuns.toReversed()) {
      restore();
    }
  };
}
