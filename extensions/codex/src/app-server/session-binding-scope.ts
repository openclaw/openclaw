import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexAppServerBindingIdentity } from "./session-binding-record.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

/** Carries one prepared run identity through callers that rederive it from public params. */
export function scopeCodexRunBindingStore(params: {
  bindingStore: CodexAppServerBindingStore;
  logicalIdentity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  physicalIdentity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
}): CodexAppServerBindingStore {
  const mapSessionIdentity = (
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ) =>
    identity.agentId === params.logicalIdentity.agentId &&
    identity.sessionId === params.logicalIdentity.sessionId &&
    identity.sessionKey?.trim() === params.logicalIdentity.sessionKey?.trim()
      ? params.physicalIdentity
      : identity;
  const mapIdentity = (identity: CodexAppServerBindingIdentity) =>
    identity.kind === "session" ? mapSessionIdentity(identity) : identity;
  const mapHistoryOwner = (
    identity: CodexAppServerBindingIdentity,
    owner: CodexNativeSubagentHistoryOwner,
  ): CodexNativeSubagentHistoryOwner => {
    const mapped = mapIdentity(identity);
    return identity.kind === "session" &&
      mapped.kind === "session" &&
      owner.sessionId === identity.sessionId
      ? { ...owner, sessionId: mapped.sessionId }
      : owner;
  };
  const readMany = params.bindingStore.readMany?.bind(params.bindingStore);
  return {
    ...params.bindingStore,
    read: (identity) => params.bindingStore.read(mapIdentity(identity)),
    ...(readMany
      ? {
          readMany: (identities: readonly CodexAppServerBindingIdentity[]) =>
            readMany(identities.map(mapIdentity)),
        }
      : {}),
    readNativeSubagentSubmissions: (identity, owner) =>
      params.bindingStore.readNativeSubagentSubmissions(
        mapIdentity(identity),
        mapHistoryOwner(identity, owner),
      ),
    hasOtherThreadOwner: (threadId, identity) =>
      params.bindingStore.hasOtherThreadOwner(
        threadId,
        identity ? mapIdentity(identity) : undefined,
      ),
    mutate: (identity, mutation, assertCurrent) =>
      params.bindingStore.mutate(
        mapIdentity(identity),
        mutation.kind === "record-native-subagent-submission" ||
          mutation.kind === "consume-native-subagent-submission"
          ? { ...mutation, owner: mapHistoryOwner(identity, mutation.owner) }
          : mutation,
        assertCurrent,
      ),
    prepareSessionGenerationReclaim: (identity) =>
      params.bindingStore.prepareSessionGenerationReclaim(mapSessionIdentity(identity)),
    adoptSessionGeneration: (identity, expectedPreviousSessionId, assertCurrent) =>
      params.bindingStore.adoptSessionGeneration(
        mapSessionIdentity(identity),
        expectedPreviousSessionId,
        assertCurrent,
      ),
    resetSessionGeneration: (identity) =>
      params.bindingStore.resetSessionGeneration(mapSessionIdentity(identity)),
    retireSessionGeneration: (identity) =>
      params.bindingStore.retireSessionGeneration(mapSessionIdentity(identity)),
    withSessionDeletion: (identity, assertCurrent, run) =>
      params.bindingStore.withSessionDeletion(mapSessionIdentity(identity), assertCurrent, run),
    withThreadArchiveFence: (run) => params.bindingStore.withThreadArchiveFence(run),
    withLease: (identity, run) => params.bindingStore.withLease(mapIdentity(identity), run),
  };
}
