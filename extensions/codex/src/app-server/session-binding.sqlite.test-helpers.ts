import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { CodexBindingStateStore, StoredCodexAppServerBinding } from "./session-binding.js";

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
  return {
    ...state,
    asyncReads: mutations,
    withCurrent: mutations.withCurrent.bind(mutations),
  };
}

/** The calling host fixture owns the runtime's isolated state scope and cleanup. */
export function createCodexRuntimeTestBindingStateStore(
  runtime: { state: Pick<PluginRuntime["state"], "openSyncKeyedStore" | "openKeyedStoreV2"> },
  options: OpenKeyedStoreOptions,
) {
  const state = runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>(options);
  const mutations = runtime.state.openKeyedStoreV2<StoredCodexAppServerBinding>(options);
  return {
    ...state,
    asyncReads: mutations,
    withCurrent: (authority: Parameters<CodexBindingStateStore["withCurrent"]>[0]) =>
      runtime.state.openKeyedStoreV2<StoredCodexAppServerBinding>(options, authority),
  };
}
