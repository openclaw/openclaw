import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  withOwnedSessionTranscriptWriterFence,
  getOwnedSessionTranscriptInitialWriter,
  captureOwnedTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type {
  PreparedCompactionAppend,
  CommittedCompactionAppend,
} from "./session-compaction-persistence.types.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import {
  receiveSessionManagerCommit,
  SessionEntryCommittedError,
} from "./session-manager-persistence-error.js";
import type {
  CompactionEntry,
  ModelChangeEntry,
  SessionEntry,
  SessionHeader,
} from "./session-manager-types.js";

export type CompactionAppendPersistence = (
  prepared: PreparedCompactionAppend,
) => CommittedCompactionAppend;

export type CompactionAppendPersistenceAsync = (
  prepared: PreparedCompactionAppend,
) => Promise<CommittedCompactionAppend>;

type CompactionInvocation<Persist = CompactionAppendPersistence> = {
  manager: object;
  persist: Persist;
  active: boolean;
};

// Native core and separately loaded SDK graphs must observe the same invocation.
const invocation = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCompactionPersistence"),
  () => new AsyncLocalStorage<CompactionInvocation>(),
);

/** Bind host accounting only to this exact manager's synchronous compaction invocation. */
export function withSessionCompactionPersistence(
  manager: object,
  persist: CompactionAppendPersistence | undefined,
  append: () => string,
): string {
  if (!persist) {
    return append();
  }
  const current = { manager, persist, active: true };
  try {
    return invocation.run(current, append);
  } finally {
    current.active = false;
  }
}

export function getSessionCompactionPersistence(
  manager: object,
): CompactionAppendPersistence | undefined {
  const current = invocation.getStore();
  return current?.active && current.manager === manager ? current.persist : undefined;
}

const asyncInvocation = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCompactionPersistenceAsync"),
  () => new AsyncLocalStorage<CompactionInvocation<CompactionAppendPersistenceAsync>>(),
);

/** Retain accounting authority until this exact manager's awaited append settles. */
export async function withSessionCompactionPersistenceAsync(
  manager: object,
  persist: CompactionAppendPersistenceAsync | undefined,
  append: () => Promise<string>,
): Promise<string> {
  if (!persist) {
    return await append();
  }
  const current = { manager, persist, active: true };
  try {
    return await asyncInvocation.run(current, append);
  } finally {
    current.active = false;
  }
}

export function getSessionCompactionPersistenceAsync(
  manager: object,
): CompactionAppendPersistenceAsync | undefined {
  const current = asyncInvocation.getStore();
  return current?.active && current.manager === manager ? current.persist : undefined;
}

/** Both public manager append and transcript-view commit use this canonical envelope. */
export function createSessionCompactionEntry(
  parentId: string | null,
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
  details?: unknown,
  fromHook?: boolean,
  metadata?: CompactionEntry["__openclaw"],
  tokensAfter?: number,
): CompactionEntry {
  return {
    type: "compaction",
    id: generateSessionEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore,
    details,
    fromHook,
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
  };
}

/** Append metadata through the SDK writer, sharing active-branch rebasing and commit fences. */
export async function appendSessionMetadataInWorker(
  prepared: Omit<PreparedCompactionAppend, "event"> & {
    event: SessionEntry;
    initialModel?: ModelChangeEntry;
    header?: SessionHeader;
  },
  assertCurrent: () => void,
): Promise<void> {
  const scope = withOwnedSessionTranscriptWriterFence({
    ...prepared.scope,
    ...captureSessionTranscriptTargetBinding(prepared.scope),
  });
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const assertActive = () => {
    assertCurrent();
    assertOwned();
  };
  const options = toDatabaseOptions(resolveSqliteTranscriptScope(scope));
  const database = captureOpenClawAgentDatabaseExecution(options);
  const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
  return trackAsyncWork(async () => {
    try {
      const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
      assertActive();
      await runOpenClawAgentWriteAdmission(
        options,
        () =>
          withSessionMetadataWorker(
            options,
            database,
            assertActive,
            async (worker) => {
              const { env: _env, ...target } = scope;
              if (prepared.header) {
                const initialized = await receiveSessionManagerCommit(
                  "session.metadata.initialize",
                  () =>
                    worker.execute({
                      type: "session.metadata.initialize",
                      input: {
                        scope: target,
                        entry: { sessionId: scope.sessionId, updatedAt: Date.now() },
                        ...(initialWriter && !initialWriter.committedFence
                          ? { initialWriterRunId: initialWriter.writerRunId }
                          : {}),
                      },
                    }),
                );
                if (initialized.failure) {
                  throw initialized.failure;
                }
                if (!initialized.value.owned) {
                  throw new Error("Session transcript header was not initialized");
                }
                if (initialized.value.fence) {
                  Object.assign(target, initialized.value.fence);
                }
                const header = await receiveSessionManagerCommit("session.metadata.append", () =>
                  worker.execute({
                    type: "session.metadata.append",
                    input: {
                      scope: target,
                      event: JSON.stringify(prepared.header),
                      options: {},
                    },
                  }),
                );
                if (header.failure) {
                  throw header.failure;
                }
                if (!header.value.snapshot.ok || !header.value.snapshot.value.result?.appended) {
                  throw new Error("Session transcript header was not persisted");
                }
                assertActive();
              }
              const receipt = await receiveSessionManagerCommit("session.metadata.append", () =>
                worker.execute({
                  type: "session.metadata.append",
                  input: {
                    scope: target,
                    event: JSON.stringify(prepared.event),
                    ...(prepared.initialModel ? { initialModel: prepared.initialModel } : {}),
                    options: {
                      appendIntent: prepared.appendIntent,
                      expectedMutationAt: prepared.expectedMutationAt,
                    },
                  },
                }),
              );
              const { snapshot, projectionNeedsReconcile } = receipt.value;
              if (
                !snapshot.ok ||
                !snapshot.value.result ||
                !("appended" in snapshot.value.result) ||
                !snapshot.value.result.appended
              ) {
                throw new Error("Session metadata was not persisted");
              }
              if (projectionNeedsReconcile) {
                startSessionTranscriptIndexReconcile({
                  ...options,
                  preferredSessionId: scope.sessionId,
                });
              }
              if (receipt.failure) {
                throw new SessionEntryCommittedError(
                  prepared.event.id,
                  scope,
                  snapshot.value.after,
                  receipt.failure,
                );
              }
            },
            { initialWriter },
          ),
        true,
      );
    } finally {
      await database.release();
    }
  });
}
