/** Lazy store facade that keeps binding schema/auth code off plugin startup. */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
import type { CodexAppServerBindingStore, StoredCodexAppServerBinding } from "./session-binding.js";

export { CODEX_APP_SERVER_BINDING_MAX_ENTRIES, CODEX_APP_SERVER_BINDING_NAMESPACE };
export type { StoredCodexAppServerBinding } from "./session-binding.js";

type CodexAppServerBindingState = Pick<
  PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
  "entries" | "lookup" | "update"
>;

/**
 * Defers schema compilation, auth loading, AND plugin-state acquisition until
 * the first binding operation. `state` may be a resolved store or a thunk; the
 * thunk (which calls `openSyncKeyedStore`) is only invoked lazily so plugin
 * registration never touches the runtime state proxy. See #107219.
 */
export function createLazyCodexAppServerBindingStore(
  state: CodexAppServerBindingState | (() => CodexAppServerBindingState),
): CodexAppServerBindingStore {
  let resolved: Promise<CodexAppServerBindingStore> | undefined;
  const store = () =>
    (resolved ??= import("./session-binding.js").then(({ createCodexAppServerBindingStore }) =>
      createCodexAppServerBindingStore(typeof state === "function" ? state() : state),
    ));
  return {
    read: async (identity) => (await store()).read(identity),
    hasOtherThreadOwner: async (threadId, currentIdentity) =>
      (await store()).hasOtherThreadOwner(threadId, currentIdentity),
    mutate: async (identity, mutation) => (await store()).mutate(identity, mutation),
    prepareSessionGenerationReclaim: async (identity) =>
      (await store()).prepareSessionGenerationReclaim(identity),
    adoptSessionGeneration: async (identity, previousSessionId) =>
      (await store()).adoptSessionGeneration(identity, previousSessionId),
    retireSessionGeneration: async (identity) => (await store()).retireSessionGeneration(identity),
    withThreadArchiveFence: async (run) => (await store()).withThreadArchiveFence(run),
    withLease: async (identity, run) => (await store()).withLease(identity, run),
  };
}
