import type { Result } from "@openclaw/normalization-core/result";
import type { CliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
  SessionManagerIncognitoDatabase,
} from "../../config/sessions/session-manager-write-contract.js";
import {
  SessionTranscriptWriterClaimReboundError,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { prepareSessionManagerMetadataCommand } from "./session-manager-metadata-command.js";
import {
  createSessionManagerPublicationHooks,
  type SessionManagerAuthorityPublication,
} from "./session-manager-publication.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);
const log = createSubsystemLogger("agents/session-metadata");

/** Each command settles and unbinds before the next; the enclosing manager keeps its FIFO turn. */
export async function withSessionMetadataWorker<T>(
  options: OpenClawAgentDatabaseOptions,
  database: OpenClawAgentDatabase | SessionManagerIncognitoDatabase,
  assertCurrent: () => void,
  operation: (scope: Pick<SqliteWorkerStore<SessionMetadataOperations>, "execute">) => Promise<T>,
  controls?: {
    beforeFreshMessageCommit?: () => void;
    initialWriter?: InitialSessionTranscriptWriter;
    beforeIdentityPublication?: (publication: SessionManagerAuthorityPublication) => void;
  },
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
  const physical = readOpenClawAgentDatabaseIdentity(database);
  const transcriptPublication =
    physical && typeof physical.identity === "string"
      ? createSessionManagerPublicationHooks({
          agentId: database.agentId,
          storePath: database.path,
          databaseIdentity: physical.identity,
          initialWriter: controls?.initialWriter,
          beforeIdentityPublication: controls?.beforeIdentityPublication,
        })
      : undefined;
  const worker = await openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>(
    options,
    database.db,
    {
      moduleUrl,
      input: undefined,
      assertAdmission: (request) =>
        admission.assertAdmission(transcriptPublication?.unwrap(request) ?? request),
      onAdmitted: transcriptPublication?.onAdmitted,
      observeAdmission: transcriptPublication?.observeAdmission,
    },
  );
  let result: Result<T, unknown>;
  try {
    const value = await operation({
      execute: async (command, commandOptions) => {
        cliWriter = prepareSessionManagerMetadataCommand(command, database.path, admission.control);
        assertMetadataCurrent();
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
          admission.publish(reply.value.pendingInputReceipt);
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
