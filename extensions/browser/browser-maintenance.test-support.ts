import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { OpenClawTestState } from "openclaw/plugin-sdk/test-state";

export async function setupMaintenance(state: OpenClawTestState, cdpUrl: string) {
  const remote = { driver: "existing-session" as const, cdpUrl };
  const config = { browser: { profiles: { remote } } };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const { initializeBrowserSessionTabStore, getBrowserSessionTabStore } =
    await import("./src/browser/session-tab-store.js");
  initializeBrowserSessionTabStore({
    state: {
      openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
    },
  });
  return { config, store: getBrowserSessionTabStore() };
}
