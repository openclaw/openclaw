import type { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { vi } from "vitest";
import { memoryForgetFaultEntrypoint } from "./memory-forget-fault-entrypoint.test-support.js";
import type { MemoryForgetFault } from "./memory-forget-fault.worker.test-support.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";

/** Forward the original source and binding to a real native fault/observation backend. */
export function observeMemoryForgetWorker(db: DatabaseSync, options: MemoryForgetFault) {
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
  const observer = vi
    .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
    .mockImplementation(async (...args) => {
      const [admission, source, worker] = args;
      if (
        admission.path !== db.location() ||
        worker.moduleUrl.href !==
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href
      ) {
        return await open(...args);
      }
      return await open(admission, source, {
        ...worker,
        moduleUrl: resolveRuntimeWorkerUrl(memoryForgetFaultEntrypoint),
        input: { binding: worker.input, ...options },
      });
    });
  return () => observer.mockRestore();
}
