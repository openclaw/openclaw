import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import type { BrowserOpenResult } from "./browser/client.types.js";
import { initializeBrowserSessionTabStore } from "./browser/session-tab-store.js";

type DashboardWidgetFixture = {
  name: string;
  instanceId: string;
  revision: number;
  contentKind: string;
  pluginKind: string;
  props: { url: string; profile?: string };
};

export function useBrowserDashboardTestHarness(
  browser: { open: Mock; tabs: Mock; ownership: Mock; closeOwned: Mock },
  sessionKey: string,
) {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let previousStateDir: string | undefined;
  let nextTarget = 0;
  const fixture = {
    stateDir: "",
    widgets: [] as DashboardWidgetFixture[],
    tabs: [] as BrowserOpenResult[],
    browserInstance: "browser-one",
    browserRunning: true,
    readBoard: vi.fn(),
    installRuntime,
    openedTab,
  };

  function installRuntime() {
    initializeBrowserSessionTabStore({
      state: {
        openSyncKeyedStore: (options) =>
          createPluginStateSyncKeyedStoreForTests("browser", options),
      },
      gateway: {
        isAvailable: async () => true,
        request: fixture.readBoard,
      } as PluginRuntime["gateway"],
    });
  }

  function openedTab(): BrowserOpenResult {
    if (!fixture.browserRunning) {
      fixture.browserRunning = true;
      fixture.browserInstance = "browser-restarted";
    }
    const targetId = `target-${++nextTarget}`;
    const tab: BrowserOpenResult = {
      targetId,
      title: "Remote service",
      url: fixture.widgets[0]?.props.url ?? "http://service.example/",
      resolvedProfile: "openclaw",
      ownership: {
        status: "durable",
        nativeTargetId: targetId,
        profileFingerprint: "profile-one",
        browserInstanceFingerprint: fixture.browserInstance,
      },
    };
    fixture.tabs.push(tab);
    return tab;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    fixture.stateDir = tempDirs.make("openclaw-browser-dashboard-");
    process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
    resetPluginStateStoreForTests();
    const config = { browser: { defaultProfile: "user" } };
    setRuntimeConfigSnapshot(config, config);
    fixture.widgets = [
      {
        name: "service",
        instanceId: "instance-one",
        revision: 1,
        contentKind: "plugin",
        pluginKind: "browser:dashboard",
        props: { url: "http://service.example/" },
      },
    ];
    fixture.tabs = [];
    nextTarget = 0;
    fixture.browserInstance = "browser-one";
    fixture.browserRunning = true;
    fixture.readBoard.mockImplementation(async (method) => {
      expect(method).toBe("board.get");
      return structuredClone({ sessionKey, widgets: fixture.widgets });
    });
    browser.open.mockImplementation(async () => openedTab());
    browser.tabs.mockImplementation(async () => ({
      running: fixture.browserRunning,
      tabs: [...fixture.tabs],
    }));
    browser.ownership.mockImplementation(async ({ nativeTargetId }) => ({
      status: "durable",
      nativeTargetId,
      profileFingerprint: "profile-one",
      browserInstanceFingerprint: fixture.browserInstance,
    }));
    browser.closeOwned.mockImplementation(
      async ({ nativeTargetId, expectedBrowserInstanceFingerprint, shouldClose }) => {
        if (!fixture.browserRunning) {
          return { status: "unavailable", reason: "browser-identity-lookup-failed" };
        }
        if (expectedBrowserInstanceFingerprint !== fixture.browserInstance) {
          return { status: "ownership-mismatch" };
        }
        if (shouldClose && !shouldClose()) {
          return { status: "cancelled" };
        }
        fixture.tabs = fixture.tabs.filter((tab) => tab.targetId !== nativeTargetId);
        return { status: "closed" };
      },
    );
    installRuntime();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    clearRuntimeConfigSnapshot();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });
  return fixture;
}
