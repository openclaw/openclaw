import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { vi } from "vitest";
import { memoryForgetFaultEntrypoint } from "./memory-forget-fault-entrypoint.test-support.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";

/** Install the real fault only after the original worker has admitted and bound its database. */
export function failMemoryEntryOriginWrites(params: {
  agentId: string;
  trigger: "reject_diary_origin" | "fail_origin_reservation";
  createSql: string;
}): () => void {
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
  const opener = vi
    .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
    .mockImplementation(async (...args) => {
      const [options, source, entrypoint] = args;
      const selected =
        options.agentId === params.agentId &&
        entrypoint.moduleUrl.href ===
          resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href;
      if (!selected) {
        return await open(...args);
      }
      return await open(options, source, {
        ...entrypoint,
        moduleUrl: resolveRuntimeWorkerUrl(memoryForgetFaultEntrypoint),
        input: {
          binding: entrypoint.input,
          originTrigger: { name: params.trigger, createSql: params.createSql },
        },
      });
    });
  return () => {
    opener.mockRestore();
  };
}
