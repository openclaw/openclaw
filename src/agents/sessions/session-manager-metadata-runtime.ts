import type { Result } from "@openclaw/normalization-core/result";
import {
  getCliHistoryWriter,
  type CliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { toIncognitoManagerCommand } from "../../config/sessions/session-incognito-manager-contract.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
  SessionManagerIncognitoDatabase,
} from "../../config/sessions/session-manager-write-contract.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { SessionManagerActorCommittedError } from "./session-manager-persistence-error.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);
const log = createSubsystemLogger("agents/session-metadata");

/** Each command settles and unbinds before the next; the enclosing manager keeps its FIFO turn. */
export async function withSessionMetadataWorker<T>(
  options: OpenClawAgentDatabaseOptions,
  database: OpenClawAgentDatabase | IncognitoSessionActor | SessionManagerIncognitoDatabase,
  assertCurrent: () => void,
  operation: (scope: Pick<SqliteWorkerStore<SessionMetadataOperations>, "execute">) => Promise<T>,
  controls?: { beforeFreshMessageCommit?: () => void },
): Promise<T> {
  if ("withMetadata" in database) {
    return await database.withMetadata(assertCurrent, operation, controls);
  }
  let cliWriter: CliHistoryWriter | undefined;
  const assertMetadataCurrent = () => {
    assertCurrent();
    cliWriter?.assertCurrent();
  };
  const admission = captureSessionMessageAdmission(assertMetadataCurrent, controls);
  const worker =
    "sessions" in database
      ? {
          execute: async <Key extends keyof SessionMetadataWorkerOperations>(command: {
            type: Key;
            input: SessionMetadataWorkerOperations[Key]["input"];
          }) => {
            let committed:
              | SessionMetadataWorkerOperations[keyof SessionMetadataWorkerOperations]["output"]
              | undefined;
            try {
              const reply = await database.sessions.transcript(
                { assertCurrent: assertMetadataCurrent },
                toIncognitoManagerCommand(command),
                undefined,
                admission.assertAdmission,
                (receipt) => {
                  committed = receipt;
                },
              );
              if (
                reply.ok &&
                reply.value &&
                typeof reply.value === "object" &&
                "projectionNeedsReconcile" in reply.value &&
                reply.value.projectionNeedsReconcile
              ) {
                const { sessionKey } = command.input.scope;
                const entry = database.sessions.readSharing(sessionKey)?.entry;
                if (!entry) {
                  throw new Error("Committed SessionManager projection lost its session");
                }
                const { reconcileSessionTranscriptIndexes } =
                  await import("../../config/sessions/session-transcript-reconcile.js");
                await reconcileSessionTranscriptIndexes(
                  { ...options, preferredSessionId: entry.sessionId },
                  {
                    actor: database,
                    authority: { assertCurrent },
                    target: {
                      sessionKey,
                      sessionId: entry.sessionId,
                      lifecycleRevision: entry.lifecycleRevision,
                    },
                  },
                );
                reply.value.projectionNeedsReconcile = false;
              }
              // SAFETY: toIncognitoManagerCommand preserves this command/result pairing.
              return reply as SessionMetadataWorkerOperations[Key]["output"];
            } catch (cause) {
              if (committed?.ok) {
                let failure = cause;
                try {
                  if (
                    committed.value &&
                    typeof committed.value === "object" &&
                    "pendingInputReceipt" in committed.value
                  ) {
                    admission.publish(committed.value.pendingInputReceipt);
                  }
                } catch (publication) {
                  failure = new AggregateError(
                    [cause, publication],
                    "Acknowledged input publication failed",
                    { cause },
                  );
                }
                throw new SessionManagerActorCommittedError(command.type, committed, failure);
              }
              throw cause;
            }
          },
          // Each command closes its binding; the borrowed actor retains the database lifetime.
          close: async () => {},
        }
      : await openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>(
          options,
          database.db,
          {
            moduleUrl,
            input: undefined,
            assertAdmission: admission.assertAdmission,
          },
        );
  let result: Result<T, unknown>;
  try {
    const value = await operation({
      execute: async (command, commandOptions) => {
        cliWriter = getCliHistoryWriter({ ...command.input.scope, storePath: database.path });
        assertMetadataCurrent();
        if (
          command.type === "session.transcript.appendMessage" ||
          command.type === "session.metadata.append"
        ) {
          command.input = {
            ...command.input,
            cliWriter: cliWriter && {
              runId: cliWriter.runId,
              authFingerprint: cliWriter.authFingerprint,
              lifecycleRevision: cliWriter.lifecycleRevision,
            },
          };
        }
        if (command.type === "session.transcript.appendMessage") {
          Object.assign(command.input, admission.control);
        }
        if (
          command.type === "session.transcript.rewrite" &&
          "entries" in command.input &&
          admission.control.pendingInput
        ) {
          command.input.pendingInput = admission.control.pendingInput;
        }
        if (
          "event" in command.input &&
          typeof command.input.event !== "string" &&
          command.input.message
        ) {
          command.input.message = {
            ...command.input.message,
            ...admission.control,
          };
        }
        const reply = await worker.execute(command, assertMetadataCurrent, commandOptions);
        if (!reply.ok) {
          throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
        }
        if (
          reply.value &&
          typeof reply.value === "object" &&
          "pendingInputReceipt" in reply.value &&
          reply.value.pendingInputReceipt
        ) {
          try {
            admission.publish(reply.value.pendingInputReceipt);
          } catch (cause) {
            if ("sessions" in database) {
              throw new SessionManagerActorCommittedError(command.type, reply, cause);
            }
            throw cause;
          }
        }
        return reply.value;
      },
    });
    result = { ok: true, value };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await worker.close();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Session metadata operation and cleanup failed",
        result.error,
      );
    }
    try {
      log.warn(`Session metadata completed before cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // A failed diagnostic cannot erase the completed operation's receipt.
    }
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
