import type { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { vi } from "vitest";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";

export function observePublishedReservations(publishedDb: DatabaseSync, onReserved: () => void) {
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
  vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
    async (...args) => {
      const worker = await open(...args);
      if (
        args[1] === publishedDb &&
        args[2].moduleUrl.href ===
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
      ) {
        const run = worker.run.bind(worker);
        vi.spyOn(worker, "run").mockImplementation((...runArgs) => {
          const result = run(...runArgs);
          onReserved();
          return result;
        });
      }
      return worker;
    },
  );
}
