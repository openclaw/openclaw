import { randomUUID } from "node:crypto";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { captureMaintenanceConfigAsyncReader } from "../../config/sessions/store-maintenance-runtime.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { updateAcpSessionStoreEntry } from "./session-meta-entry.js";
import {
  buildAcpDatabaseSessionKey,
  legacyAcpDatabaseSessionKeys,
  resolveLegacyFreeAcpSessionKey,
} from "./session-meta-keys.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import { upsertAcpSessionMetaNative } from "./session-meta-write.native.js";
import type {
  AcpSessionMutationCommit,
  AcpSessionMutationDecision,
  AcpSessionMutationPreparation,
} from "./session-meta-write.types.js";

type AcpSessionMutationParams = Parameters<typeof upsertAcpSessionMetaNative>[0];

/** File-backed writes retain their read source through both canonical storage owners. */
export async function upsertAcpSessionMeta(
  params: AcpSessionMutationParams,
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
  if (isIncognitoSessionKey(sessionKey)) {
    return upsertAcpSessionMetaNative({
      ...params,
      ...captured,
      expectedControlBinding,
      assertCommitAllowed: captured.assertCurrent,
    });
  }
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
      if (readOwner.kind === "native") {
        return upsertAcpSessionMetaNative({
          ...params,
          ...captured,
          expectedControlBinding,
          assertCommitAllowed: captured.assertCurrent,
        });
      }
      if (!readerScope?.storePath) {
        throw new Error("ACP mutation has no retained canonical source");
      }
      const options = {
        agentId: readerScope.databaseAgentId ?? readerScope.agentId ?? store.agentId,
        path: readerScope.storePath,
        env: captured.env,
      };
      if (!supportsOpenClawAgentDatabaseExecution(options)) {
        return upsertAcpSessionMetaNative({
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
      const key = normalizeStoreSessionKey(store.storeSessionKey);
      const updatedAt = params.now?.() ?? Date.now();
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        identity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: identity.key.slice(5),
                nativeLocation: identity.canonicalPath,
                birthtime: identity.birthtime,
              },
            }
          : { expectedCreationIdentity: identity },
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
      let decision: AcpSessionMutationDecision | undefined;
      try {
        const nonce = randomUUID();
        const preparation = await runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute({
              type: "acp.prepareMutation",
              input: {
                nonce,
                read: {
                  keys: [
                    buildAcpDatabaseSessionKey(key, store.agentId),
                    ...legacyAcpDatabaseSessionKeys(key, store.agentId, captured.cfg),
                  ],
                  legacyKey: resolveLegacyFreeAcpSessionKey(key),
                  entry,
                },
                entry,
                updatedAt,
                source: source(),
                sessionKey: key,
                agentId: store.agentId,
                expectedControlBinding,
              },
            }),
          {
            assertCurrent,
            createAdmission() {
              let phase: "transaction" | "commit" | "settled" = "transaction";
              const admission = createSqliteWorkerOperationAdmission((request, grant) => {
                const facts = request.facts;
                const port =
                  isRecord(facts) && facts.preparationPort instanceof MessagePort
                    ? facts.preparationPort
                    : undefined;
                try {
                  assertCurrent();
                  if (!isRecord(facts) || facts.nonce !== nonce || request.stage !== phase) {
                    throw new Error("ACP callback differs from its retained transaction");
                  }
                  if (request.stage === "transaction") {
                    if (!port || decision) {
                      throw new Error("ACP callback has no unique decision port");
                    }
                    // SAFETY: this private worker supplies this operation's authoritative row snapshot.
                    const prepared = facts.preparation as AcpSessionMutationPreparation;
                    const next = params.mutate(
                      prepared.current,
                      prepared.current
                        ? mergeSessionEntry(prepared.preparedEntry, { acp: prepared.current })
                        : prepared.entry,
                    );
                    decision =
                      next === undefined
                        ? { kind: "keep" }
                        : next === null
                          ? { kind: "clear" }
                          : { kind: "set", meta: next };
                    assertCurrent();
                    port.postMessage(decision, []);
                    phase = "commit";
                  } else {
                    phase = "settled";
                  }
                  if (!grant()) {
                    throw new Error("ACP callback admission expired");
                  }
                } finally {
                  port?.close();
                }
              });
              return { nativeLocations: [context.admission.databasePath, options.path], admission };
            },
          },
        );
        assertCurrent();
        const selected = decision;
        if (!selected) {
          throw new Error("ACP metadata mutation returned no decision");
        }
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
        const update = (
          mutation: Parameters<typeof updateAcpSessionStoreEntry>[0]["mutation"],
          expectedEntry = preparation.entry ?? null,
          skipMaintenance = params.skipMaintenance,
        ) =>
          updateAcpSessionStoreEntry({
            options,
            scope,
            storePath: store.storePath,
            execution,
            assertCurrent,
            readOwner,
            mutation,
            expectedEntry,
            expectedControlBinding,
            prepareMaintenance,
            skipMaintenance,
          });
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
        const cleanup = async () => {
          await update({ kind: "clear-legacy" }, commitEntry ?? null, true);
          assertCurrent();
        };
        if (selected.kind === "set") {
          await cleanup();
        }
        await commitAcpSessionMutation(
          context,
          {
            agentId: store.agentId,
            storageSessionKey: key,
            sessionKey: key,
            entry: commitEntry,
            currentRowKey: preparation.currentRowKey,
            updatedAt,
            decision: selected,
            source: source(),
            expectedControlBinding,
          },
          assertCurrent,
        );
        assertCurrent();
        if (selected.kind === "clear") {
          await cleanup();
          return changed.entry;
        }
        return mergeSessionEntry(changed.entry ?? undefined, { acp: selected.meta });
      } finally {
        await execution.release();
      }
    },
  );
}

async function commitAcpSessionMutation(
  context: ReturnType<typeof captureOpenClawStateWorkerContext>,
  input: AcpSessionMutationCommit,
  assertCurrent: () => void,
) {
  const nonce = randomUUID();
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  let published = false;
  const publish = () => {
    const receipt = admitted?.admission.committed?.facts;
    if (!published && isRecord(receipt) && receipt.nonce === nonce) {
      published = true;
      sessionChanges.emit({ agentId: input.agentId, sessionKey: input.sessionKey });
    }
  };
  try {
    await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        try {
          await scope.execute({ type: "acp.commitMutation", input: { ...input, nonce } });
        } finally {
          await admitted?.retained.settled;
          publish();
        }
      },
      {
        assertCurrent,
        createAdmission(retained) {
          let phase: "transaction" | "commit" | "settled" = "transaction";
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            assertCurrent();
            if (
              !isRecord(request.facts) ||
              request.facts.nonce !== nonce ||
              request.stage !== phase
            ) {
              throw new Error("ACP metadata commit differs from its retained owner");
            }
            phase = request.stage === "transaction" ? "commit" : "settled";
            if (!grant()) {
              throw new Error("ACP metadata commit admission expired");
            }
          });
          admitted = { admission, retained };
          return {
            nativeLocations: [context.admission.databasePath, input.source.path],
            admission,
          };
        },
      },
    );
  } finally {
    await admitted?.retained.settled;
    publish();
  }
}
