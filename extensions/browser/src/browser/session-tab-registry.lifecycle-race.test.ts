// Browser tests cover lifecycle priority over durable sweep cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import type { BrowserTabOwnership } from "./client.types.js";

type DurableRecord = {
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
  lastUsedAt: number;
};

type RegistryModule = {
  trackSessionBrowserTab(params: {
    sessionKey: string;
    targetId: string;
    profile: string;
    ownership: BrowserTabOwnership;
    aliases?: string[];
    now?: number;
  }): void;
  touchSessionBrowserTab(params: {
    sessionKey: string;
    targetId: string;
    profile: string;
    now?: number;
  }): void;
  closeTrackedBrowserTabsForSessions(params: {
    sessionKeys: string[];
    resolveOwnership: () => Promise<BrowserTabOwnership>;
    closeTab: () => Promise<void>;
  }): Promise<number>;
  sweepTrackedBrowserTabs(params: {
    now: number;
    idleMs: number;
    resolveOwnership: () => Promise<BrowserTabOwnership>;
    closeTab: () => Promise<void>;
  }): Promise<number>;
};

const durableOwnership: BrowserTabOwnership = {
  status: "durable",
  nativeTargetId: "NATIVE-A",
  profileFingerprint: "sha256:profile",
  browserInstanceFingerprint: "sha256:browser",
};

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let stateDir = "";
let freshModuleCounter = 0;

function installRuntime(): void {
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
          openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
            createPluginStateSyncKeyedStoreForTests("browser", options),
        },
      } as unknown as OpenClawPluginApi["runtime"],
    }),
  );
}

function openStore() {
  return createPluginStateSyncKeyedStoreForTests<unknown>("browser", {
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
}

async function freshRegistry(label: string): Promise<RegistryModule> {
  freshModuleCounter += 1;
  return await importFreshModule<RegistryModule>(
    import.meta.url,
    `./session-tab-registry.js?lifecycle-race=${label}-${freshModuleCounter}`,
  );
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-lifecycle-race-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetPluginStateStoreForTests();
  installRuntime();
  openStore().clear();
});

afterEach(async () => {
  const registry = await freshRegistry("cleanup");
  await registry.closeTrackedBrowserTabsForSessions({
    sessionKeys: ["agent:main:main"],
    resolveOwnership: async () => durableOwnership,
    closeTab: async () => {},
  });
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

it("upgrades an in-flight sweep so lifecycle cleanup survives touch and closes once", async () => {
  const registry = await freshRegistry("priority");
  registry.trackSessionBrowserTab({
    sessionKey: "agent:main:main",
    targetId: "RAW-A",
    profile: "remote",
    ownership: durableOwnership,
    aliases: ["RAW-A", "docs"],
    now: 1_000,
  });
  let releaseSweepOwnership: (() => void) | undefined;
  let markSweepOwnershipStarted: (() => void) | undefined;
  const sweepOwnershipStarted = new Promise<void>((resolve) => {
    markSweepOwnershipStarted = resolve;
  });
  const sweepOwnershipGate = new Promise<void>((resolve) => {
    releaseSweepOwnership = resolve;
  });
  let ownershipCalls = 0;
  const resolveOwnership = vi.fn(async () => {
    ownershipCalls += 1;
    if (ownershipCalls === 1) {
      markSweepOwnershipStarted?.();
      await sweepOwnershipGate;
    }
    return durableOwnership;
  });
  const closeTab = vi.fn(async () => {});
  const sweep = registry.sweepTrackedBrowserTabs({
    now: 10_000,
    idleMs: 1,
    resolveOwnership,
    closeTab,
  });
  await sweepOwnershipStarted;
  const sweepClaim = openStore().entries()[0]?.value as DurableRecord;

  const lifecycle = registry.closeTrackedBrowserTabsForSessions({
    sessionKeys: ["agent:main:main"],
    resolveOwnership,
    closeTab,
  });
  const upgradedClaim = openStore().entries()[0]?.value as DurableRecord;
  registry.touchSessionBrowserTab({
    sessionKey: "agent:main:main",
    targetId: "docs",
    profile: "remote",
    now: 11_000,
  });
  releaseSweepOwnership?.();

  await expect(Promise.all([sweep, lifecycle])).resolves.toEqual([0, 1]);
  expect(sweepClaim.cleanupKind).toBe("sweep");
  expect(upgradedClaim).toMatchObject({
    cleanupKind: "lifecycle",
    cleanupAttemptToken: expect.any(String),
    lastUsedAt: 1_000,
  });
  expect(upgradedClaim.cleanupAttemptToken).not.toBe(sweepClaim.cleanupAttemptToken);
  expect(resolveOwnership).toHaveBeenCalledTimes(2);
  expect(closeTab).toHaveBeenCalledOnce();
  expect(openStore().entries()).toEqual([]);
});
