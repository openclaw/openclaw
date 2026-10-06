/** Binding reads with lazy mutation, lease, and auth machinery. */
import {
  createCodexManagedThreadStore,
  type CodexManagedThreadStore,
} from "./managed-thread-store.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
import {
  readCurrentNativePendingAssignments,
  readCurrentCodexAppServerBinding,
  readCurrentCodexAppServerBindings,
  readCurrentCodexNativeSubagentSubmissions,
} from "./session-binding-record.js";
import type { CodexAppServerBindingStore, CodexBindingStateStore } from "./session-binding.js";

export { CODEX_APP_SERVER_BINDING_MAX_ENTRIES, CODEX_APP_SERVER_BINDING_NAMESPACE };
export type { StoredCodexAppServerBinding } from "./session-binding.js";

/** Keeps lifecycle/auth loading behind mutations while sharing the canonical read codec. */
export function createLazyCodexAppServerBindingStore(
  state: CodexBindingStateStore,
  managedThreadState?: Parameters<typeof createCodexManagedThreadStore>[0],
): CodexAppServerBindingStore {
  let resolved: Promise<CodexAppServerBindingStore> | undefined;
  const store = () =>
    (resolved ??= import("./session-binding.js").then(({ createCodexAppServerBindingStore }) =>
      createCodexAppServerBindingStore(state),
    ));
  const managedThreads: CodexManagedThreadStore | undefined = managedThreadState
    ? createCodexManagedThreadStore(managedThreadState)
    : undefined;
  return {
    ...(managedThreads ? { managedThreads } : {}),
    read: (identity) => readCurrentCodexAppServerBinding(state, identity),
    readMany: (identities) => readCurrentCodexAppServerBindings(state.asyncReads, identities),
    readNativeSubagentAssignments: (identity, owner) =>
      readCurrentNativePendingAssignments(state, identity, owner),
    readNativeSubagentSubmissions: (identity, owner) =>
      readCurrentCodexNativeSubagentSubmissions(state, identity, owner),
    hasOtherThreadOwner: async (threadId, currentIdentity) =>
      (await store()).hasOtherThreadOwner(threadId, currentIdentity),
    mutate: async (identity, mutation, assertCurrent, authority) =>
      (await store()).mutate(identity, mutation, assertCurrent, authority),
    prepareSessionGenerationReclaim: async (identity) =>
      (await store()).prepareSessionGenerationReclaim(identity),
    adoptSessionGeneration: async (identity, previousSessionId, assertCurrent, authority) =>
      (await store()).adoptSessionGeneration(identity, previousSessionId, assertCurrent, authority),
    resetSessionGeneration: async (identity) => (await store()).resetSessionGeneration(identity),
    retireSessionGeneration: async (identity) => (await store()).retireSessionGeneration(identity),
    withSessionDeletion: async (identity, assertCurrent, run) =>
      (await store()).withSessionDeletion(identity, assertCurrent, run),
    withThreadArchiveFence: async (run) => (await store()).withThreadArchiveFence(run),
    withLease: async (identity, run, options) => (await store()).withLease(identity, run, options),
  };
}
