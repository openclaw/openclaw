import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { kickSessionEntryMaintenanceAfterWrite } from "../../config/sessions/session-accessor.sqlite-maintenance-kick.js";
import { withSessionEntryWorker } from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteSessionKey,
  resolveSqliteTranscriptArchiveDirectory,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "../../config/sessions/session-history-eviction.js";
import { captureMaintenanceConfigAsyncReader } from "../../config/sessions/store-maintenance-runtime.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { wrapSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { toAgentExecutionConstraints } from "../../state/openclaw-agent-execution-scope.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { AcpSessionControlConstraint } from "./session-meta-control.types.js";
import { captureAcpSessionEntryBinding } from "./session-meta-entry.kernel.js";
import type {
  AcpSessionEntryMutation,
  AcpSessionEntryMutationResult,
} from "./session-meta-entry.types.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { upsertMemoryAcpSessionMeta } from "./session-meta-memory.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import {
  prepareAcpSessionMutation,
  commitAcpSessionMutation,
} from "./session-meta-worker-mutation.js";
import { upsertAcpSessionMetaForMaintenance } from "./session-meta-write.native.js";
import type { AcpSessionMutationParams } from "./session-meta-write.types.js";

/** Entry changes follow the selected session owner; ACP metadata keeps its shared worker. */
export async function upsertAcpSessionMeta(
  params: AcpSessionMutationParams,
): Promise<SessionEntry | null> {
  return isIncognitoSessionKey(params.sessionKey.trim())
    ? upsertMemoryAcpSessionMeta(params)
    : mutateAcpSessionMeta(params);
}

/** Private control updates cannot recreate metadata that disappeared after preparation. */
export async function upsertAcpSessionMetaForControl(
  params: AcpSessionMutationParams,
  constraint: AcpSessionControlConstraint,
): Promise<SessionEntry | null> {
  return mutateAcpSessionMeta(params, structuredClone(constraint));
}

async function mutateAcpSessionMeta(
  params: AcpSessionMutationParams,
  control?: AcpSessionControlConstraint,
): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const expectedControlBinding = params.expectedControlBinding
    ? {
        sessionId: params.expectedControlBinding.sessionId,
        lifecycleRevision: params.expectedControlBinding.lifecycleRevision,
        sessionStartedAt: params.expectedControlBinding.sessionStartedAt,
        ownerKey: params.expectedControlBinding.ownerKey,
      }
    : undefined;
  const captured = await captureAcpSessionReadContext({
    ...params,
    assertCurrent: params.assertCommitAllowed,
  });
  const store = resolveSessionStorePathForAcp({ ...captured, sessionKey, agentId: params.agentId });
  return withSessionEntryReadOnlyInWorker(
    {
      agentId: store.agentId,
      storePath: store.storePath,
      sessionKey: store.storeSessionKey,
      env: captured.env,
    },
    captured.assertCurrent,
    async (read, readOwner) => {
      if (!read.ok) {
        throw read.error;
      }
      const entry = read.value;
      const readerScope = readOwner.scope;
      if (!readerScope?.storePath) {
        throw new Error("ACP mutation has no retained canonical source");
      }
      const options = {
        agentId: readerScope.databaseAgentId ?? readerScope.agentId ?? store.agentId,
        path: readerScope.storePath,
        env: captured.env,
      };
      if (!supportsOpenClawAgentDatabaseExecution(options)) {
        // Memory readers return before this file-backed scope; only native maintenance remains.
        if (control) {
          throw new Error("ACP controlled metadata mutation requires its durable worker source");
        }
        return upsertAcpSessionMetaForMaintenance({
          ...params,
          ...captured,
          expectedControlBinding,
          assertCommitAllowed: readOwner.assertCurrent,
        });
      }
      const identity = readDatabasePathIdentitySync(options.path);
      const context = captureOpenClawStateWorkerContext({
        path: captured.databasePath,
        env: captured.env,
      });
      const prepareMaintenance = captureMaintenanceConfigAsyncReader(captured.assertCurrent);
      const key = store.storeSessionKey;
      const metadataRead = {
        keys: [buildAcpDatabaseSessionKey(key, store.agentId)],
      };
      if (
        control &&
        (control.agentId !== store.agentId ||
          control.sessionKey !== key ||
          control.source.agentId !== options.agentId ||
          !isDeepStrictEqual(control.source.identity, identity) ||
          !isDeepStrictEqual(control.sharedSource.identity, context.admission.identity) ||
          !isDeepStrictEqual(control.read.keys, metadataRead.keys))
      ) {
        throw new Error("ACP controlled metadata mutation does not match its prepared target");
      }
      const updatedAt = params.now?.() ?? Date.now();
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        toAgentExecutionConstraints(identity),
      );
      const assertCurrent = () => {
        captured.assertCurrent();
        readOwner.assertCurrent();
        execution.assertCurrent();
        context.admission.assertCurrent();
        prepareMaintenance.assertCurrent();
      };
      const source = () => {
        const accepted = execution.fileIdentity;
        return {
          agentId: options.agentId,
          path: options.path,
          identity: accepted
            ? {
                key: `file:${accepted.physicalIdentity}`,
                canonicalPath: identity.canonicalPath,
                birthtime: accepted.birthtime,
              }
            : identity,
        };
      };
      try {
        const { preparation, decision: selected } = await prepareAcpSessionMutation(
          context,
          {
            read: { ...metadataRead, entry },
            entry,
            updatedAt,
            source: source(),
            sessionKey: key,
            agentId: store.agentId,
            expectedControlBinding,
            control,
          },
          params.mutate,
          assertCurrent,
        );
        assertCurrent();
        if (selected.kind === "keep") {
          return preparation.current
            ? mergeSessionEntry(preparation.entry, { acp: preparation.current })
            : (preparation.entry ?? null);
        }
        const scope = {
          agentId: store.agentId,
          databaseAgentId: options.agentId,
          path: options.path,
          env: captured.env,
          sessionKey: resolveSqliteSessionKey(key, store.agentId),
        };
        const update = async (
          mutation: AcpSessionEntryMutation,
        ): Promise<AcpSessionEntryMutationResult> => {
          const expectedEntry = preparation.entry ?? null;
          const skipMaintenance = params.skipMaintenance;
          let admitted:
            | {
                admission: SqliteWorkerOperationAdmission;
                retained: RetainedWorkerTransactionAdmission;
              }
            | undefined;
          let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
          let result: AcpSessionEntryMutationResult | undefined;
          const maintenanceConfig = await prepareMaintenance();
          assertCurrent();
          await withSessionEntryWorker(
            options,
            execution.fileIdentity?.physicalIdentity,
            assertCurrent,
            async (owner, entrySource) => {
              entrySource.onRegistryChange = readOwner.onRegistryChange;
              await readOwner.refreshBeforeDispatch?.(() => owner.assertCurrent());
              await owner.prepare(entrySource);
              assertCurrent();
              const entryIdentity = owner.fileIdentity;
              if (!entryIdentity) {
                throw new Error("ACP entry mutation has no admitted physical owner");
              }
              publication = retainSessionEntryWorkerPublication({
                agentId: options.agentId,
                storePath: options.path,
                databaseIdentity: entryIdentity.physicalIdentity,
              });
              const executed = await owner.runExisting(entrySource, async (worker) => {
                const outcome = await worker
                  .execute({
                    type: "session.entry.acp",
                    input: {
                      agentId: scope.agentId,
                      sessionKey: scope.sessionKey,
                      mutation,
                      expectedEntry:
                        expectedEntry === null
                          ? null
                          : captureAcpSessionEntryBinding(expectedEntry),
                      expectedControlBinding,
                    },
                  })
                  .then(
                    (value) => ({ ok: true as const, value }),
                    (error: unknown) => ({ ok: false as const, error }),
                  );
                if (admitted) {
                  const settlement = await admitted.retained.settled;
                  const receipt = admitted.admission.committed?.facts;
                  if (isRecord(receipt) && receipt.kind === "acp-entry-mutation") {
                    // SAFETY: this command's retained native receipt is emitted by its paired finite kernel.
                    result = receipt.result as AcpSessionEntryMutationResult;
                  }
                  const unknown = admitted.admission.settlement?.kind !== "completed" || !result;
                  const published = publication?.settle(result?.publication, unknown);
                  if (published) {
                    publishCommittedSessionIdentity(
                      scope.agentId,
                      entryIdentity.physicalIdentity,
                      published.previous,
                      published.current,
                      published.prepared,
                    );
                  }
                  if (unknown) {
                    throw wrapSqliteWorkerError(
                      "ACP entry mutation has no confirmed native settlement",
                      "outcome-unknown",
                      !outcome.ok ? outcome.error : undefined,
                      settlement.kind !== "completed" ? settlement.error : undefined,
                    );
                  }
                }
                if (!outcome.ok) {
                  throw outcome.error;
                }
                result ??= outcome.value;
                return result;
              });
              if (!executed) {
                throw new Error("ACP entry database disappeared before mutation");
              }
              await readOwner.revalidateTarget?.();
            },
            (admission, retained, facts) => {
              admitted = { admission, retained };
              if (
                isRecord(facts) &&
                isRecord(facts.publication) &&
                facts.publication.kind === "session-entry-replacements"
              ) {
                // SAFETY: the paired canonical entry kernel supplies the existing publication contract.
                const receipt = facts.publication as NonNullable<
                  AcpSessionEntryMutationResult["publication"]
                >;
                publication?.begin(
                  receipt.changedKeys,
                  receipt.membershipInvalidatedKeys,
                  receipt.sharingUnchangedKeys,
                  receipt.generationUnchangedKeys,
                  undefined,
                  new Map(
                    [...receipt.current].filter(
                      ([entryKey]) => !receipt.unavailableParticipantKeys?.includes(entryKey),
                    ),
                  ),
                );
              }
            },
            execution,
          );
          if (!result) {
            throw new Error("ACP entry mutation returned no result");
          }
          assertCurrent();
          if (result.publication) {
            kickSessionEntryMaintenanceAfterWrite({
              activeSessionKey: scope.sessionKey,
              archiveDirectory: resolveSqliteTranscriptArchiveDirectory(scope),
              scope,
              skipMaintenance,
              maintenanceConfig,
              storePath: store.storePath,
            });
            kickSessionHistoryDiskBudgetMaintenance({
              agentId: scope.agentId,
              env: scope.env,
              storePath: store.storePath,
              maintenanceConfig,
            });
          }
          return result;
        };
        const changed =
          selected.kind === "clear"
            ? preparation.entry
              ? await update({ kind: "clear" })
              : { entry: null }
            : await update({ kind: "touch", updatedAt, fallbackEntry: preparation.preparedEntry });
        assertCurrent();
        if (selected.kind === "set" && !changed.entry) {
          return null;
        }
        const commitEntry = changed.entry ?? preparation.entry;
        await commitAcpSessionMutation(
          context,
          {
            agentId: store.agentId,
            storageSessionKey: key,
            sessionKey: key,
            entry: commitEntry,
            currentRowKey: preparation.currentRowKey,
            currentRowSessionId: preparation.currentRowSessionId,
            updatedAt,
            decision: selected,
            source: source(),
            expectedControlBinding,
            control,
          },
          assertCurrent,
        );
        assertCurrent();
        if (selected.kind === "clear") {
          return changed.entry;
        }
        return mergeSessionEntry(changed.entry ?? undefined, { acp: selected.meta });
      } finally {
        await execution.release();
      }
    },
  );
}
