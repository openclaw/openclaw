import type { SessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../../config/sessions/session-actor-storage-contract.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { matchesAcpSessionControlBinding } from "./session-control-owner.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import type {
  AcpSessionEntryReadInput,
  PreparedAcpSessionEntryRead,
} from "./session-meta-read.types.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import {
  commitAcpSessionMutation,
  prepareAcpSessionMutation,
} from "./session-meta-worker-mutation.js";
import type { upsertAcpSessionMetaNative } from "./session-meta-write.native.js";
import type { AcpSessionMutationSource } from "./session-meta-write.types.js";

/** The session actor owns entries; the existing shared worker owns ACP runtime metadata. */
export async function prepareMemoryAcpSessionEntryRead(
  params: AcpSessionEntryReadInput,
  binding: SessionActorStorageBinding,
): Promise<PreparedAcpSessionEntryRead> {
  const captured = await captureAcpSessionReadContext(params);
  const target = resolveSessionStorePathForAcp({ ...params, ...captured });
  const entry = binding.actor.snapshot(binding.authority)?.entry;
  const [acp] = await readAcpSessionMetaForEntries({
    entries: [{ sessionKey: target.storeSessionKey, agentId: binding.agentId, entry }],
    ...captured,
  });
  let active = true;
  return {
    session: {
      ...target,
      storePath: binding.path,
      sessionKey: params.sessionKey.trim(),
      entry,
      acp: acp ?? undefined,
    },
    assertCurrent() {
      if (!active) {
        throw new Error("ACP session read was released");
      }
      params.assertCurrent?.();
      binding.actor.snapshot(binding.authority);
    },
    release() {
      active = false;
    },
  };
}

export async function upsertMemoryAcpSessionMeta(
  params: Parameters<typeof upsertAcpSessionMetaNative>[0],
  binding: SessionActorStorageBinding,
): Promise<SessionEntry | null> {
  const captured = await captureAcpSessionReadContext(params);
  const target = resolveSessionStorePathForAcp({ ...params, ...captured });
  const context = captureOpenClawStateWorkerContext({
    path: captured.databasePath,
    env: captured.env,
  });
  const sessionKey = target.storeSessionKey;
  const assertControlTarget = (entry: SessionEntry | undefined) => {
    if (
      params.expectedControlBinding &&
      !matchesAcpSessionControlBinding(entry, params.expectedControlBinding)
    ) {
      throw new Error("Canonical ACP control target changed before mutation");
    }
  };
  const authority: SessionActorStorageAuthority = {
    ...binding.authority,
    authorize(stage, facts, publication) {
      binding.authority.authorize(stage, facts, publication);
      if (stage === "transaction") {
        params.assertCommitAllowed?.();
        assertControlTarget(facts.entry);
      }
    },
  };
  const assertCurrent = () => {
    binding.actor.assertCurrent();
    binding.authority.assertCurrent();
  };
  const entry = binding.actor.snapshot(authority)?.entry;
  const source = (
    current: SessionEntry | undefined,
  ): Extract<AcpSessionMutationSource, { kind: "memory" }> => ({
    kind: "memory",
    agentId: binding.agentId,
    path: binding.path,
    snapshot: { entry: current, sources: [] },
  });
  const updatedAt = params.now?.() ?? Date.now();
  const { preparation, decision } = await prepareAcpSessionMutation(
    context,
    {
      read: { keys: [buildAcpDatabaseSessionKey(sessionKey, binding.agentId)], entry },
      entry,
      source: source(entry),
      updatedAt,
      sessionKey,
      agentId: binding.agentId,
    },
    params.mutate,
    assertCurrent,
  );
  if (decision.kind === "keep") {
    return preparation.current
      ? mergeSessionEntry(entry, { acp: preparation.current })
      : (entry ?? null);
  }
  const outcome = await binding.actor.storage!.mutate(
    {
      type: "session.entry.patch",
      input: {
        operation: {
          kind: "fields",
          patch: { acp: undefined, ...(decision.kind === "set" ? { updatedAt } : {}) },
        },
        ...(decision.kind === "set" ? { fallbackEntry: preparation.preparedEntry } : {}),
        preserveActivity: decision.kind === "clear",
      },
    },
    authority,
  );
  if (outcome.kind === "rolled-back") {
    throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
  }
  const changed = outcome.value;
  if (decision.kind === "set" && !changed) {
    return null;
  }
  // The shared writer invalidates its old metadata before admission. Settle this
  // accepted entry change without testing that deliberately invalidated view.
  await commitAcpSessionMutation(
    context,
    {
      agentId: binding.agentId,
      storageSessionKey: sessionKey,
      sessionKey,
      entry: changed,
      currentRowKey: preparation.currentRowKey,
      currentRowSessionId: preparation.currentRowSessionId,
      updatedAt,
      decision,
      source: source(changed),
    },
    assertCurrent,
    params.expectedControlBinding
      ? (stage) => {
          if (stage === "commit") {
            assertControlTarget(binding.actor.snapshot(binding.authority)?.entry);
          }
        }
      : undefined,
  );
  return decision.kind === "clear"
    ? (changed ?? null)
    : mergeSessionEntry(changed, { acp: decision.meta });
}
