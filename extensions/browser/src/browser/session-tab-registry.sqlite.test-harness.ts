import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import type { closeTrackedCdpTarget } from "./cdp.helpers.js";
import type { RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";
import { ensureBrowserSessionTabStoreReady } from "./session-tab-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn<typeof closeTrackedCdpTarget>(),
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

  async function installRuntime(
    openKeyedStore: (options: OpenKeyedStoreOptions) => PluginStateKeyedStore<unknown> = (
      options,
    ) => createPluginStateKeyedStoreForTests("browser", options),
  ): Promise<void> {
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: "/plugins/browser",
        config: {},
        runtime: {
          state: {
            openKeyedStore,
          },
        } as unknown as OpenClawPluginApi["runtime"],
      }),
    );
    await ensureBrowserSessionTabStoreReady();
  }

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?durable=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(async () => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-browser-tabs-");
    resetPluginStateStoreForTests();
    await installRuntime();
    openStore().clear();
    cdpMocks.closeTrackedCdpTarget
      .mockReset()
      .mockImplementation(async ({ closeIfCurrent }) =>
        closeIfCurrent
          ? await closeIfCurrent(async () => ({ status: "closed" }))
          : { status: "closed" },
      );
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

export function setBrowserProfileConfig(): void {
  const config = {
    browser: {
      defaultProfile: "remote",
      profiles: {
        remote: {
          driver: "existing-session",
          cdpUrl: "http://127.0.0.1:9222",
          color: "#123456",
        },
      },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config, config);
}
