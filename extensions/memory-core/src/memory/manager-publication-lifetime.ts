import type { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentSqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";

export async function withMemoryPublicationExecution(
  params: {
    database: DatabaseSync;
    options: Parameters<typeof openOpenClawAgentSqliteWorkerStore>[0] | undefined;
  },
  run: () => Promise<void>,
): Promise<void> {
  // This store only borrows the canonical executor; it never dispatches a
  // command. Concrete publication stores still own their policy and cleanup.
  const execution = params.options
    ? await openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(
        params.options,
        params.database,
        {
          moduleUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
          input: undefined,
          retainExecutionUntilClose: true,
        },
      )
    : undefined;
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  try {
    await execution?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${String(failures[0])}; Memory sync cleanup failed`, {
      cause: failures[0],
    });
  }
}
