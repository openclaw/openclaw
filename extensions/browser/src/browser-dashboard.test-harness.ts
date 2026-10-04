import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import { getBrowserStateRuntime } from "./browser-runtime-state.js";
import type { BrowserOpenResult } from "./browser/client.types.js";
import {
  ensureBrowserSessionTabStoreReady,
  initializeBrowserSessionTabStore,
} from "./browser/session-tab-store.js";

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
    get gateway(): PluginRuntime["gateway"] {
      return {
        isAvailable: async () => true,
        request: fixture.readBoard,
        subscribeSessionChanges() {
          throw new Error("Unexpected session change subscription");
        },
        async readSessionFacts() {
          throw new Error("Unexpected session facts request");
        },
        async openPluginPanel() {
          throw new Error("Unexpected plugin panel request");
        },
      };
    },
    installRuntime,
    openedTab,
  };

  async function installRuntime() {
    const runtime = initializeBrowserSessionTabStore({
      state: {
        openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
      },
      gateway: fixture.gateway,
    });
    await ensureBrowserSessionTabStoreReady(runtime);
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

  beforeEach(async () => {
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
      async ({ nativeTargetId, expectedBrowserInstanceFingerprint, closeIfCurrent }) => {
        if (!fixture.browserRunning) {
          return { status: "unavailable", reason: "browser-identity-lookup-failed" };
        }
        if (expectedBrowserInstanceFingerprint !== fixture.browserInstance) {
          return { status: "ownership-mismatch" };
        }
        const dispatch = async () => {
          fixture.tabs = fixture.tabs.filter((tab) => tab.targetId !== nativeTargetId);
          return { status: "closed" as const };
        };
        return closeIfCurrent ? await closeIfCurrent(dispatch) : await dispatch();
      },
    );
    await installRuntime();
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

export function interceptStoreActions(
  transform: (store: PluginStateKeyedStore<unknown, 2>) => PluginStateKeyedStore<unknown, 2>,
) {
  const store = getBrowserStateRuntime().sessionTabs;
  const withCurrent = store.withCurrent!;
  return vi
    .spyOn(store, "withCurrent")
    .mockImplementation((authority) => transform(withCurrent(authority)));
}
