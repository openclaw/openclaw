import type { CliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import type { SessionActorMemoryMetadataCommand } from "../../config/sessions/session-actor-memory-metadata-contract.js";
import type {
  SessionManagerIncognitoDatabase,
  SessionMetadataOperations,
} from "../../config/sessions/session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/session-transcript-writer-claim-error.js";
import type { SessionManagerMemoryBinding } from "./session-manager-incognito-scope.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { prepareSessionManagerMetadataCommand } from "./session-manager-metadata-command.js";
import { SessionManagerActorCommittedError } from "./session-manager-persistence-error.js";

/** Adapts the existing manager contract to its selected actor, without opening a database. */
export function createSessionManagerMemoryDatabase(
  binding: SessionManagerMemoryBinding,
): SessionManagerIncognitoDatabase {
  const { actor, storage, database } = binding;
  if (actor.target.database.kind !== "memory") {
    throw new Error("Session manager memory binding requires a memory actor");
  }
  return {
    path: database.path,
    identity: { incarnation: actor.target.database.incarnation },
    async withMetadata(assertCurrent, operation, controls) {
      let cliWriter: CliHistoryWriter | undefined;
      let commandSignal: AbortSignal | undefined;
      const assertMetadataCurrent = () => {
        commandSignal?.throwIfAborted();
        assertCurrent();
        binding.authority.assertCurrent();
        cliWriter?.assertCurrent();
        controls?.initialWriter?.assertActive();
      };
      const admission = captureSessionMessageAdmission(assertMetadataCurrent, controls);
      const authority = {
        assertCurrent: assertMetadataCurrent,
        authorize(
          stage: "transaction" | "commit",
          facts: Parameters<typeof binding.authority.authorize>[1],
          publication?: unknown,
        ) {
          binding.authority.authorize(stage, facts, publication);
          admission.assertAdmission({ stage, facts: publication });
        },
      };
      const execute = async (command: SessionActorMemoryMetadataCommand) => {
        cliWriter = prepareSessionManagerMetadataCommand(command, database.path, admission.control);
        if (command.type === "session.metadata.mutation") {
          return storage.read(command, authority);
        }
        const initialWriterRunId =
          "initialWriterRunId" in command.input ? command.input.initialWriterRunId : undefined;
        if (
          initialWriterRunId !== undefined &&
          initialWriterRunId !== controls?.initialWriter?.writerRunId
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        const outcome = await storage.mutate(command, authority, {
          committed(receipt) {
            const value = receipt.value;
            const initial =
              value &&
              ("owned" in value ? value : "initialEntry" in value ? value.initialEntry : undefined);
            if (initial?.fence && !controls?.initialWriter?.committedFence) {
              controls?.initialWriter?.recordCommitted(initial.fence);
            }
            if (value && "pendingInputReceipt" in value) {
              admission.publish(value.pendingInputReceipt);
            }
          },
        });
        if (outcome.kind === "rolled-back") {
          if (outcome.error.name === "SessionTranscriptWriterClaimReboundError") {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          if (outcome.error.name === "SqliteTranscriptMutationConflictError") {
            throw new SqliteTranscriptMutationConflictError(command.input.scope.sessionId);
          }
          throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
        }
        if (outcome.failure) {
          throw new SessionManagerActorCommittedError(
            command.type,
            { ok: true, value: outcome.value },
            Object.assign(new Error(outcome.failure.message), { name: outcome.failure.name }),
          );
        }
        return outcome.value;
      };
      return operation({
        async execute<Key extends keyof SessionMetadataOperations>(
          command: {
            type: Key;
            input: SessionMetadataOperations[Key]["input"];
          },
          options?: { signal?: AbortSignal },
        ) {
          commandSignal = options?.signal;
          commandSignal?.throwIfAborted();
          // The manager contract pairs each metadata key with the same actor operation/result.
          return execute(command as SessionActorMemoryMetadataCommand) as Promise<
            SessionMetadataOperations[Key]["output"]
          >;
        },
      });
    },
  };
}
