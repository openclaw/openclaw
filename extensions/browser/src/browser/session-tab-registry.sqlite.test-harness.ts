import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn<() => Promise<CloseTrackedCdpTargetResult>>(),
}));

export { cdpMocks };

vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  closeTrackedCdpTarget: cdpMocks.closeTrackedCdpTarget,
}));

export function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.volatile-cleanup",
    "openclaw.browser.session-tabs.active-durable-keys",
    "openclaw.browser.session-tabs.cold-native-activity",
    "openclaw.browser.session-tabs.interaction-storage-keys",
    "openclaw.browser.session-tabs.exact-interaction-storage-keys",
    "openclaw.browser.session-tabs.volatile-aliases",
    "openclaw.browser.session-tabs.exact-volatile-aliases",
  ]) {
    delete state[Symbol.for(name)];
  }
}

export function installSessionTabRegistrySqliteHarness() {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let freshModuleCounter = 0;

  function openStore(): PluginStateSyncKeyedStore<unknown> {
    return createPluginStateSyncKeyedStoreForTests("browser", {
      namespace: "browser.session-tabs",
      maxEntries: 5_000,
      overflowPolicy: "reject-new",
    });
  }

  function installRuntime(
    openSyncKeyedStore: (options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<unknown> = (
      options,
    ) => createPluginStateSyncKeyedStoreForTests("browser", options),
  ): void {
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: "/plugins/browser",
        config: {},
        runtime: {
          state: {
            openKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateKeyedStoreForTests("browser", options),
            openSyncKeyedStore,
          },
        } as unknown as OpenClawPluginApi["runtime"],
      }),
    );
  }

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?durable=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-browser-tabs-");
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
    cdpMocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    resetPluginStateStoreForTests();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  return { openStore, installRuntime, freshRegistry };
}
