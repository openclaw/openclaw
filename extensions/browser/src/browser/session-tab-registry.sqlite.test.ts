// Browser tests cover durable session tab cleanup through the real plugin-state store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { browserSessionTabStorageKey } from "./session-tab-store.js";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
}));
const cdpMocks = vi.hoisted(() => ({
  closeCdpTargetById: vi.fn(async () => {}),
  resolveCdpTabOwnership: vi.fn(),
}));

vi.mock("./client.js", () => clientMocks);
vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  closeCdpTargetById: cdpMocks.closeCdpTargetById,
  resolveCdpTabOwnership: cdpMocks.resolveCdpTabOwnership,
}));

type TabIdentity = {
  sessionKey?: string;
  targetId?: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;

type RegistryModule = {
  trackSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  touchSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  untrackSessionBrowserTab(params: TabIdentity): void;
  closeTrackedBrowserTabsForSessions(params: {
    sessionKeys: Array<string | undefined>;
    closeTab?: CloseTab;
    resolveOwnership?: (
      tab: TabIdentity & { nativeTargetId?: string },
    ) => Promise<BrowserTabOwnership | null>;
    onWarn?: (message: string) => void;
  }): Promise<number>;
  sweepTrackedBrowserTabs(params: {
    now?: number;
    idleMs?: number;
    maxTabsPerSession?: number;
    sessionFilter?: (sessionKey: string) => boolean;
    closeTab?: CloseTab;
    resolveOwnership?: (
      tab: TabIdentity & { nativeTargetId?: string },
    ) => Promise<BrowserTabOwnership | null>;
    onWarn?: (message: string) => void;
  }): Promise<number>;
};

type DurableRecord = {
  version: 1;
  sessionKey: string;
  nativeTargetId: string;
  profile: string;
  profileFingerprint: string;
  browserInstanceFingerprint: string;
  trackedAt: number;
  lastUsedAt: number;
  cleanupRequestedAt?: number;
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
};

const ownership = (
  nativeTargetId: string,
  profileFingerprint = "test-profile-fingerprint",
  browserInstanceFingerprint = "test-browser-instance-fingerprint",
): BrowserTabOwnership => ({
  status: "durable",
  nativeTargetId,
  profileFingerprint,
  browserInstanceFingerprint,
});

const matchingOwnership = async (tab: { nativeTargetId?: string }) =>
  ownership(tab.nativeTargetId ?? "");

function setBrowserProfileConfig(params: {
  name: string;
  driver: "existing-session" | "openclaw";
  cdpUrl: string;
  color: `#${string}`;
}): void {
  const { name, ...profile } = params;
  const config = {
    browser: {
      defaultProfile: name,
      profiles: { [name]: profile },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config, config);
}

describe("durable session tab registry", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
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
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-tabs-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
    clientMocks.browserCloseTabByRawTargetId.mockClear();
    cdpMocks.closeCdpTargetById.mockClear();
    cdpMocks.resolveCdpTabOwnership.mockReset();
  });

  afterEach(async () => {
    const cleanup = await freshRegistry("after-each");
    await cleanup.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main", "agent:main:subagent:child"],
      resolveOwnership: matchingOwnership,
      closeTab: async () => {},
    });
    clearRuntimeConfigSnapshot();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("closes a durable tab after the SQLite database and module are reopened", async () => {
    const first = await freshRegistry("first");
    first.trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "interaction-target",
      profile: "Remote",
      ownership: ownership("NATIVE-1"),
      now: 1_000,
    });

    const stored = openStore().entries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(stored[0]?.key).not.toMatch(/agent|interaction|native/i);
    expect(stored[0]?.value).not.toHaveProperty("baseUrl");
    expect(stored[0]?.value).not.toHaveProperty("interactionTargetId");

    resetPluginStateStoreForTests();
    installRuntime();
    const restarted = await freshRegistry("restarted");
    const closeTab = vi.fn(async () => {});

    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        resolveOwnership: matchingOwnership,
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "NATIVE-1",
      nativeTargetId: "NATIVE-1",
      profile: "remote",
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("keeps external control URLs volatile across duplicate module instances", async () => {
    const first = await freshRegistry("fixture-control");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "interaction-fixture",
      baseUrl: "http://127.0.0.1:9222/control",
      profile: "remote",
      ownership: ownership("NATIVE-FIXTURE"),
    });

    expect(openStore().entries()).toEqual([]);
    const duplicateBundle = await freshRegistry("fixture-control-duplicate");
    const closeTab = vi.fn(async () => {});
    await expect(
      duplicateBundle.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "interaction-fixture",
      baseUrl: "http://127.0.0.1:9222/control",
      profile: "remote",
    });
  });

  it("keys durable records by canonical ownership rather than rotating interaction handles", async () => {
    const registry = await freshRegistry("canonical-key");
    const durableOwnership = ownership("NATIVE-1");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-before",
      profile: "remote",
      ownership: durableOwnership,
      now: 1_000,
    });
    const before = openStore().entries();

    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-after",
      profile: "remote",
      ownership: durableOwnership,
      now: 2_000,
    });
    const after = openStore().entries();

    expect(after).toHaveLength(1);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-1",
      trackedAt: 1_000,
      lastUsedAt: 2_000,
    });
    expect(after[0]?.value).not.toHaveProperty("interactionTargetId");
  });

  it("rejects the 5001st durable record without evicting canonical entries", async () => {
    const registry = await freshRegistry("capacity");
    for (let index = 0; index < 5_000; index += 1) {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: `alias-${index}`,
        profile: "remote",
        ownership: ownership(`NATIVE-${index}`),
        now: index,
      });
    }
    const firstKey = openStore().entries()[0]?.key;

    expect(() =>
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "overflow",
        profile: "remote",
        ownership: ownership("NATIVE-OVERFLOW"),
      }),
    ).toThrow(/limit|maximum|5000/i);
    expect(openStore().entries()).toHaveLength(5_000);
    expect(openStore().lookup(firstKey ?? "")).toBeDefined();
  });

  it("moves a durable tab to volatile on a real non-durable ownership transition", async () => {
    const first = await freshRegistry("durability-switch-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "interaction-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    expect(openStore().entries()).toHaveLength(1);

    const duplicateBundle = await freshRegistry("durability-switch-duplicate");
    duplicateBundle.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "interaction-a",
      profile: "remote",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
    });
    expect(openStore().entries()).toEqual([]);

    const closeTab = vi.fn(async () => {});
    await expect(
      first.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "interaction-a",
      profile: "remote",
    });
  });

  it("tracks, touches, untracks, and isolates durable records by profile", async () => {
    const registry = await freshRegistry("mutations");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "same-target",
      profile: "alpha",
      ownership: ownership("NATIVE-A", "test-profile-fingerprint"),
      now: 1_000,
    });
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "same-target",
      profile: "beta",
      ownership: ownership("NATIVE-B", "fixture-profile-fingerprint"),
      now: 2_000,
    });
    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "same-target",
      nativeTargetId: "NATIVE-A",
      profile: "alpha",
      ownership: ownership("NATIVE-A", "test-profile-fingerprint"),
      now: 3_000,
    });
    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "not-tracked",
      profile: "alpha",
      now: 4_000,
    });

    const records = openStore()
      .entries()
      .map((entry) => entry.value as DurableRecord)
      .toSorted((a, b) => a.profile.localeCompare(b.profile));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      profile: "alpha",
      nativeTargetId: "NATIVE-A",
      trackedAt: 1_000,
      lastUsedAt: 3_000,
    });
    expect(records[1]).toMatchObject({
      profile: "beta",
      nativeTargetId: "NATIVE-B",
      trackedAt: 2_000,
      lastUsedAt: 2_000,
    });

    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "rotated-alias",
      nativeTargetId: "NATIVE-A",
      profile: "alpha",
      ownership: ownership("NATIVE-A", "test-profile-fingerprint"),
    });
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).profile),
    ).toEqual(["beta"]);
  });

  it("touches and untracks a durable record through same-process open aliases", async () => {
    const registry = await freshRegistry("same-process-aliases");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      aliases: ["RAW-A", "t1", "docs", "docs"],
      now: 1_000,
    });

    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "remote",
      now: 9_000,
    });
    expect(openStore().entries()).toMatchObject([{ value: { lastUsedAt: 9_000 } }]);

    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "t1",
      profile: "remote",
    });

    expect(openStore().entries()).toEqual([]);
  });

  it("does not scan SQLite to recover aliases after a process restart", async () => {
    const registry = await freshRegistry("cold-alias");
    const record: DurableRecord = {
      version: 1,
      sessionKey: "agent:main:cold",
      nativeTargetId: "NATIVE-COLD",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    };
    const key = browserSessionTabStorageKey(record);
    openStore().register(key, record);

    registry.touchSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
      now: 9_000,
    });
    registry.untrackSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
    });

    expect(openStore().lookup(key)).toMatchObject({ lastUsedAt: 1_000 });
  });

  it("throws when durable registration cannot write SQLite", async () => {
    installRuntime((options) => {
      const store = createPluginStateSyncKeyedStoreForTests("browser", options);
      return new Proxy(store, {
        get(target, property) {
          if (property === "update") {
            return () => {
              throw new Error("sqlite unavailable");
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const registry = await freshRegistry("write-failure");

    expect(() =>
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "tab-a",
        profile: "remote",
        ownership: ownership("NATIVE-A"),
      }),
    ).toThrow("sqlite unavailable");
  });

  it("deletes success and not-found records but preserves transient failures as pending", async () => {
    const registry = await freshRegistry("outcomes");
    for (const targetId of ["success", "not-found", "transient"]) {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId,
        profile: "remote",
        ownership: ownership(`NATIVE-${targetId}`),
      });
    }
    const closeTab = vi.fn<CloseTab>(async (tab) => {
      if (tab.nativeTargetId === "NATIVE-not-found") {
        throw new Error("target not found");
      }
      if (tab.nativeTargetId === "NATIVE-transient") {
        throw new Error("network down");
      }
    });

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        resolveOwnership: matchingOwnership,
        closeTab,
      }),
    ).resolves.toBe(1);

    const pending = openStore()
      .entries()
      .map((entry) => entry.value as DurableRecord);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      nativeTargetId: "NATIVE-transient",
      cleanupRequestedAt: expect.any(Number),
      cleanupKind: "lifecycle",
    });
  });

  it("closes explicit existing-session targets through their current CDP endpoint", async () => {
    setBrowserProfileConfig({
      name: "remote",
      driver: "existing-session",
      cdpUrl: "http://127.0.0.1:9223",
      color: "#00AA00",
    });
    cdpMocks.resolveCdpTabOwnership.mockResolvedValueOnce(ownership("NATIVE-7"));
    const registry = await freshRegistry("existing-session");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "mcp-page-7",
      profile: "remote",
      ownership: ownership("NATIVE-7"),
    });

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
      }),
    ).resolves.toBe(1);
    expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
    expect(cdpMocks.closeCdpTargetById).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9223",
      targetId: "NATIVE-7",
      timeoutMs: expect.any(Number),
      ssrfPolicy: expect.objectContaining({
        hostnameAllowlist: expect.arrayContaining(["127.0.0.1"]),
      }),
    });
    expect(cdpMocks.resolveCdpTabOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:9223",
        nativeTargetId: "NATIVE-7",
        ssrfPolicy: expect.objectContaining({
          hostnameAllowlist: expect.arrayContaining(["127.0.0.1"]),
        }),
      }),
    );
  });

  it("closes managed durable targets through raw control using the native id", async () => {
    setBrowserProfileConfig({
      name: "managed",
      driver: "openclaw",
      cdpUrl: "http://127.0.0.1:9224",
      color: "#0000AA",
    });
    const registry = await freshRegistry("managed");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-7",
      profile: "managed",
      ownership: ownership("NATIVE-7"),
    });

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        resolveOwnership: matchingOwnership,
      }),
    ).resolves.toBe(1);
    expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledWith(undefined, "NATIVE-7", {
      profile: "managed",
      timeoutMs: expect.any(Number),
    });
  });

  it("retries pending child-session cleanup after restart even when the sweep filter excludes it", async () => {
    const first = await freshRegistry("pending-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "child-tab",
      profile: "remote",
      ownership: ownership("NATIVE-CHILD"),
    });
    await first.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      resolveOwnership: matchingOwnership,
      closeTab: async () => {
        throw new Error("socket timed out");
      },
    });
    const pendingChild = openStore().entries()[0]?.value as DurableRecord | undefined;
    expect(pendingChild).toMatchObject({ cleanupKind: "lifecycle" });
    expect(pendingChild?.cleanupAttemptToken).toEqual(expect.any(String));

    resetPluginStateStoreForTests();
    installRuntime();
    const restarted = await freshRegistry("pending-restarted");
    const closeTab = vi.fn(async () => {});
    let releaseOwnership: (() => void) | undefined;
    let markOwnershipStarted: (() => void) | undefined;
    const ownershipStarted = new Promise<void>((resolve) => {
      markOwnershipStarted = resolve;
    });
    const ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const retry = restarted.sweepTrackedBrowserTabs({
      now: Date.now() + 60_000,
      idleMs: 1,
      sessionFilter: () => false,
      resolveOwnership: async (tab) => {
        markOwnershipStarted?.();
        await ownershipGate;
        return await matchingOwnership(tab);
      },
      closeTab,
    });
    await ownershipStarted;
    const retriedClaim = openStore().entries()[0]?.value;
    releaseOwnership?.();
    await expect(retry).resolves.toBe(1);
    expect(retriedClaim).toMatchObject({ cleanupKind: "lifecycle" });
    expect(closeTab).toHaveBeenCalledOnce();
    expect(openStore().entries()).toEqual([]);
  });

  it("deduplicates concurrent cleanup across fresh module instances", async () => {
    const first = await freshRegistry("concurrent-first");
    const second = await freshRegistry("concurrent-second");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    second.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    let releaseClose: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeTab = vi.fn(async () => {
      await closeStarted;
    });

    const firstClose = first.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: matchingOwnership,
      closeTab,
    });
    await vi.waitFor(() => expect(closeTab).toHaveBeenCalledOnce());
    const secondClose = second.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: matchingOwnership,
      closeTab,
    });
    releaseClose?.();

    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([1, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("does not delete a durable record re-tracked while its prior close is pending", async () => {
    const registry = await freshRegistry("retrack-race");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-before",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      now: 1_000,
    });
    let releaseClose: (() => void) | undefined;
    let markCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closing = registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: matchingOwnership,
      closeTab: async () => {
        markCloseStarted?.();
        await closeGate;
      },
    });
    await closeStarted;

    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-after",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      now: 2_000,
    });
    releaseClose?.();
    await expect(closing).resolves.toBe(1);

    expect(openStore().entries()).toMatchObject([
      {
        value: {
          lastUsedAt: 2_000,
        },
      },
    ]);
    expect(openStore().entries()[0]?.value).not.toHaveProperty("interactionTargetId");
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("keeps a lifecycle cleanup claimed when canonical touch races before close", async () => {
    const registry = await freshRegistry("lifecycle-touch-race");
    const durableOwnership = ownership("NATIVE-A");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-before",
      profile: "remote",
      ownership: durableOwnership,
      now: 1_000,
    });
    let releaseOwnership: (() => void) | undefined;
    let markOwnershipStarted: (() => void) | undefined;
    const ownershipStarted = new Promise<void>((resolve) => {
      markOwnershipStarted = resolve;
    });
    const ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const closeTab = vi.fn(async () => {});
    const closing = registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: async () => {
        markOwnershipStarted?.();
        await ownershipGate;
        return durableOwnership;
      },
      closeTab,
    });
    await ownershipStarted;
    const claimed = openStore().entries()[0]?.value;

    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "stale-alias",
      nativeTargetId: "NATIVE-A",
      profile: "remote",
      ownership: durableOwnership,
      now: 9_000,
    });
    releaseOwnership?.();
    await expect(closing).resolves.toBe(1);
    expect(claimed).toMatchObject({ cleanupKind: "lifecycle" });
    expect((claimed as DurableRecord | undefined)?.cleanupAttemptToken).toEqual(expect.any(String));
    expect(closeTab).toHaveBeenCalledOnce();
    expect(openStore().entries()).toEqual([]);
  });

  it("cancels a sweep cleanup claim when canonical touch wins before close", async () => {
    const registry = await freshRegistry("sweep-touch-race");
    const durableOwnership = ownership("NATIVE-A");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-before",
      profile: "remote",
      ownership: durableOwnership,
      now: 1_000,
    });
    let releaseOwnership: (() => void) | undefined;
    let markOwnershipStarted: (() => void) | undefined;
    const ownershipStarted = new Promise<void>((resolve) => {
      markOwnershipStarted = resolve;
    });
    const ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const closeTab = vi.fn(async () => {});
    const closing = registry.sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      resolveOwnership: async () => {
        markOwnershipStarted?.();
        await ownershipGate;
        return durableOwnership;
      },
      closeTab,
    });
    await ownershipStarted;
    const claimed = openStore().entries()[0]?.value;

    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "stale-alias",
      nativeTargetId: "NATIVE-A",
      profile: "remote",
      ownership: durableOwnership,
      now: 11_000,
    });
    releaseOwnership?.();

    await expect(closing).resolves.toBe(0);
    expect(claimed).toMatchObject({ cleanupKind: "sweep" });
    expect((claimed as DurableRecord | undefined)?.cleanupAttemptToken).toEqual(expect.any(String));
    expect(closeTab).not.toHaveBeenCalled();
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 11_000 });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupKind");
  });

  it("stops a stale cleanup attempt when another process replaces its token", async () => {
    const registry = await freshRegistry("attempt-race");
    const durableOwnership = ownership("NATIVE-A");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "alias-a",
      profile: "remote",
      ownership: durableOwnership,
    });
    let releaseOwnership: (() => void) | undefined;
    let markOwnershipStarted: (() => void) | undefined;
    const ownershipStarted = new Promise<void>((resolve) => {
      markOwnershipStarted = resolve;
    });
    const ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const closeTab = vi.fn(async () => {});
    const closing = registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: async () => {
        markOwnershipStarted?.();
        await ownershipGate;
        return durableOwnership;
      },
      closeTab,
    });
    await ownershipStarted;

    const store = openStore();
    const storageKey = store.entries()[0]?.key;
    expect(
      store.update?.(storageKey ?? "", (current) => ({
        ...(current as DurableRecord),
        cleanupRequestedAt: Date.now(),
        cleanupAttemptToken: "test-cleanup-attempt-token",
        cleanupKind: "lifecycle",
      })),
    ).toBe(true);
    releaseOwnership?.();

    await expect(closing).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
    expect(openStore().entries()[0]?.value).toMatchObject({
      cleanupAttemptToken: "test-cleanup-attempt-token",
      cleanupKind: "lifecycle",
    });
  });

  it("keeps transient ownership lookup failures pending", async () => {
    const registry = await freshRegistry("ownership-transient");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    const closeTab = vi.fn(async () => {});

    await registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: async () => {
        throw new Error("identity network timeout");
      },
      closeTab,
    });
    await registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: async () => ({
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      }),
      closeTab,
    });
    expect(closeTab).not.toHaveBeenCalled();
    const deferred = openStore().entries()[0]?.value as DurableRecord | undefined;
    expect(deferred?.cleanupRequestedAt).toEqual(expect.any(Number));
    expect(deferred?.cleanupAttemptToken).toEqual(expect.any(String));
  });

  it("retains a successfully closed record when delete fails, then converges on not-found", async () => {
    const realStore = openStore();
    let failDelete = true;
    installRuntime(
      () =>
        new Proxy(realStore, {
          get(target, property) {
            if (property === "deleteIf") {
              return (...args: Parameters<NonNullable<typeof target.deleteIf>>) => {
                if (failDelete) {
                  failDelete = false;
                  throw new Error("delete unavailable");
                }
                return target.deleteIf?.(...args);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    const first = await freshRegistry("delete-failure");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    await first.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: matchingOwnership,
      closeTab: async () => {},
    });
    expect(openStore().entries()).toHaveLength(1);

    resetPluginStateStoreForTests();
    installRuntime();
    const restarted = await freshRegistry("delete-failure-restart");
    await restarted.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      resolveOwnership: matchingOwnership,
      closeTab: async () => {
        throw new Error("target not found");
      },
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("deletes a schema-valid durable record stored under the wrong key", async () => {
    openStore().register("wrong-storage-key", {
      version: 1,
      sessionKey: "agent:main:main",
      nativeTargetId: "NATIVE-WRONG-KEY",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord);

    await (
      await freshRegistry("wrong-key")
    ).closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:other"],
      closeTab: async () => {},
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("deletes a previously valid row when its recomputed key does not match", async () => {
    openStore().register("wrong-legacy-key", {
      version: 1,
      sessionKey: "agent:main:main",
      interactionTargetId: "legacy-alias",
      nativeTargetId: "NATIVE-LEGACY",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    });

    await (
      await freshRegistry("wrong-legacy-key")
    ).closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:other"],
      closeTab: async () => {},
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("retires invalid and mismatched records without closing their native targets", async () => {
    const registry = await freshRegistry("retire");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "mismatch",
      profile: "remote",
      ownership: ownership("NATIVE-MISMATCH"),
    });
    openStore().register("invalid-record", { version: 999, sessionKey: "agent:main:main" });
    const closeTab = vi.fn(async () => {});
    const warnings: string[] = [];

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        resolveOwnership: async () =>
          ownership(
            "NATIVE-MISMATCH",
            "fixture-profile-fingerprint",
            "fixture-browser-instance-fingerprint",
          ),
        closeTab,
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
    expect(openStore().entries()).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(/invalid.*session tab/i),
      expect.stringMatching(/ownership mismatch/i),
    ]);
  });

  it("keeps non-durable tabs out of SQLite but shared across duplicate bundles", async () => {
    const first = await freshRegistry("volatile-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "volatile",
      profile: "remote",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
    });
    expect(openStore().entries()).toEqual([]);

    const restarted = await freshRegistry("volatile-restarted");
    const closeTab = vi.fn(async () => {});
    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });
});
