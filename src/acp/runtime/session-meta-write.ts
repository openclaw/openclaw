import { isDeepStrictEqual } from "node:util";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionOperation } from "../../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import { captureMaintenanceConfigAsyncReader } from "../../config/sessions/store-maintenance-runtime.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { AcpSessionControlConstraint } from "./session-meta-control.types.js";
import { updateAcpSessionStoreEntry } from "./session-meta-entry.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { upsertMemoryAcpSessionMeta } from "./session-meta-memory.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import {
  prepareAcpSessionMutation,
  commitAcpSessionMutation,
  upsertIncognitoAcpSessionMeta,
} from "./session-meta-worker-mutation.js";
import { upsertAcpSessionMetaNative } from "./session-meta-write.native.js";

type AcpSessionMutationParams = Parameters<typeof upsertAcpSessionMetaNative>[0];

/** File-backed writes retain their read source through both canonical storage owners. */
export async function upsertAcpSessionMeta(
  params: AcpSessionMutationParams,
  incognito?: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority },
): Promise<SessionEntry | null> {
  const memory = getSessionActorStorageBinding({ ...params, sessionKey: params.sessionKey.trim() });
  if (memory && params.sessionKey.trim()) {
    return upsertMemoryAcpSessionMeta(params, memory);
  }
  const binding = incognito ?? captureIncognitoSessionOperation(params);
  const sessionKey = params.sessionKey.trim();
  // Empty keys keep the shared no-op result without entering either storage owner.
  if (!binding || !sessionKey) {
    return mutateAcpSessionMeta(params);
  }
  const { actor, authority } = binding;
  actor.assertCurrent();
  authority.assertCurrent();
  const input = {
    ...params,
    sessionKey,
    expectedControlBinding:
      params.expectedControlBinding && structuredClone(params.expectedControlBinding),
  };
  const context = captureAcpSessionReadContext({
    ...input,
    assertCurrent: input.assertCommitAllowed,
  });
  const result = await actor.sessions.withSharedState(async () => {
    const captured = await context;
    const target = resolveSessionStorePathForAcp({ ...input, ...captured });
    if (target.agentId !== actor.agentId) {
      throw new Error("ACP mutation differs from its captured incognito actor");
    }
    const value = await upsertIncognitoAcpSessionMeta({
      actor,
      ...input,
      ...captured,
      sessionKey: target.storeSessionKey,
      authority: {
        assertCurrent() {
          captured.assertCurrent();
          authority.assertCurrent();
        },
        authorize: (stage, facts) => authority.authorize?.(stage, facts),
      },
    });
    return { value, assertCurrent: captured.assertCurrent };
  });
  result.assertCurrent();
  authority.assertCurrent();
  actor.assertReadable();
  return result.value;
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
  const mutateNative = (assertCommitAllowed = captured.assertCurrent) => {
    if (control) {
      throw new Error("ACP controlled metadata mutation requires its durable worker source");
    }
    return upsertAcpSessionMetaNative({
      ...params,
      ...captured,
      expectedControlBinding,
      assertCommitAllowed,
    });
  };
  if (isIncognitoSessionKey(sessionKey)) {
    return mutateNative();
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
        return mutateNative();
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
        return mutateNative(readOwner.assertCurrent);
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
        const update = (mutation: Parameters<typeof updateAcpSessionStoreEntry>[0]["mutation"]) =>
          updateAcpSessionStoreEntry({
            options,
            scope,
            storePath: store.storePath,
            execution,
            assertCurrent,
            readOwner,
            mutation,
            expectedEntry: preparation.entry ?? null,
            expectedControlBinding,
            prepareMaintenance,
            skipMaintenance: params.skipMaintenance,
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
