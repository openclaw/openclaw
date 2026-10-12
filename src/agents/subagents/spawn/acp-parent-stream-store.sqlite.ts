import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { runtimeProcessEntrypoints } from "../../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../../infra/runtime-worker-url.js";
import { throwSqliteLifecycleErrors } from "../../../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../../state/openclaw-state-worker-error.js";
import type { AcpParentStreamWorkerOperations } from "./acp-parent-stream-store.worker.js";

export type AcpParentStreamEvent = Record<string, unknown>;
type EventBatch = Array<{ event: AcpParentStreamEvent; createdAt: number }>;

/** Captures the child and physical store before delayed relay flushes can yield. */
export function createAcpParentStreamRecorder(
  input: OpenClawAgentDatabaseOptions & { sessionId: string; runId: string },
) {
  const options = { ...input, env: cloneEnvWithPlatformSemantics(input.env ?? process.env) };
  const identity = readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(options));
  if (!identity.key.startsWith("file:")) {
    throw new Error("ACP parent-stream diagnostics require the existing child database");
  }
  const execution = captureOpenClawAgentDatabaseExecution(options, {
    expectedIdentity: {
      kind: "file",
      physicalIdentity: identity.key.slice("file:".length),
      nativeLocation: identity.canonicalPath,
      birthtime: identity.birthtime,
    },
  });
  options.path = execution.path;
  const worker = openOpenClawAgentSqliteWorkerStore<AcpParentStreamWorkerOperations>(
    options,
    { execution },
    {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.acpParentStreamStore),
      input: undefined,
    },
  );
  // A relay may finish without any serializable diagnostics.
  void worker.catch(() => {});
  return {
    async record(events: EventBatch): Promise<Result<void, Error>> {
      const prepared = events.flatMap((entry) => {
        try {
          const eventJson = JSON.stringify(entry.event);
          if (eventJson !== undefined) {
            return [{ eventJson, createdAt: entry.createdAt }];
          }
        } catch {
          // One malformed diagnostic must not poison later valid events or retries.
        }
        return [];
      });
      if (prepared.length === 0) {
        return { ok: true, value: undefined };
      }
      const result = await runOpenClawAgentWriteAdmission(
        options,
        async () =>
          (await worker).execute(
            {
              type: "record",
              input: { sessionId: options.sessionId, runId: options.runId, events: prepared },
            },
            () => execution.assertCurrent(),
          ),
        true,
      );
      if (result.ok) {
        return result;
      }
      const error = new Error("ACP parent-stream transaction rolled back");
      retainOpenClawStateWorkerErrorPayload(error, result.error);
      return {
        ok: false,
        error: hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }),
      };
    },
    async close(): Promise<void> {
      const failures: unknown[] = [];
      for (const close of [async () => (await worker).close(), () => execution.release()]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      throwSqliteLifecycleErrors(failures, "ACP parent-stream recorder cleanup failed");
    },
  };
}
