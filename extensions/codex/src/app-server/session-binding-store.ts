/** Synchronous binding reads with lazy mutation, lease, and auth machinery. */
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createCodexManagedThreadStore,
  type CodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
import {
  readCurrentCodexAppServerBinding,
  readCurrentCodexAppServerBindings,
  readCurrentCodexNativeSubagentSubmissions,
} from "./session-binding-record.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  StoredCodexAppServerBinding,
} from "./session-binding.js";

export { CODEX_APP_SERVER_BINDING_MAX_ENTRIES, CODEX_APP_SERVER_BINDING_NAMESPACE };
export type { StoredCodexAppServerBinding } from "./session-binding.js";

/** Keeps lifecycle/auth loading behind mutations while sharing the canonical read codec. */
export function createLazyCodexAppServerBindingStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
    "deleteIf" | "entries" | "lookup" | "lookupMany" | "registerIfAbsent" | "update"
  >,
  managedThreadState?: Pick<
    PluginStateKeyedStore<StoredCodexManagedThread>,
    "entries" | "lookup" | "registerIfAbsent"
  >,
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
    // Capability discovery can open plugin state; keep it out of registration.
    get readMany() {
      return state.lookupMany
        ? (identities: readonly CodexAppServerBindingIdentity[]) =>
            readCurrentCodexAppServerBindings(state, identities)
        : undefined;
    },
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
