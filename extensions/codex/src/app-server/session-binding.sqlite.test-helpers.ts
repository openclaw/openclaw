import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { StoredCodexAppServerBinding } from "./session-binding.js";

/** Both adapters address the fixture's exact plugin namespace and private state directory. */
export function createCodexSqliteTestBindingStateStore(
  options: OpenKeyedStoreOptions & { env: NodeJS.ProcessEnv },
) {
  if (!options.env.OPENCLAW_STATE_DIR) {
    throw new Error("Codex SQLite binding fixtures require a private state directory");
  }
  const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>(
    "codex",
    options,
  );
  const mutations = createPluginStateKeyedStoreForTests<StoredCodexAppServerBinding>(
    "codex",
    options,
  );
  return { ...state, withCurrent: mutations.withCurrent.bind(mutations) };
}

/** The calling host fixture owns the runtime's isolated state scope and cleanup. */
export function createCodexRuntimeTestBindingStateStore(
  runtime: { state: Pick<PluginRuntime["state"], "openSyncKeyedStore" | "openKeyedStore"> },
  options: OpenKeyedStoreOptions,
) {
  const state = runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>(options);
  const mutations = runtime.state.openKeyedStore<StoredCodexAppServerBinding>(options);
  if (!mutations.withCurrent) {
    throw new Error("Codex binding fixtures require action-bound plugin-state mutations");
  }
  return { ...state, withCurrent: mutations.withCurrent.bind(mutations) };
}
