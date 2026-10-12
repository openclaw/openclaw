// Browser tests cover process-local session tab cleanup behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloseTab, RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
}));

vi.mock("./client-tab-close.runtime.js", () => clientMocks);

import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab as trackSessionBrowserTabRuntime,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

const trackedSessionKeys = new Set<string>();

function trackSessionBrowserTab(params: Parameters<typeof trackSessionBrowserTabRuntime>[0]) {
  if (params.sessionKey) {
    trackedSessionKeys.add(params.sessionKey);
  }
  return trackSessionBrowserTabRuntime(params);
}

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientMocks.browserCloseTabByRawTargetId.mockClear();
    trackedSessionKeys.clear();
  });

  afterEach(async () => {
    await closeTrackedBrowserTabsForSessions({
      sessionKeys: [...trackedSessionKeys],
      closeTab: async () => {},
    });
    vi.useRealTimers();
  });

  it("reserves cleanup while its client closes before an overlapping closer can fail", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    clientMocks.browserCloseTabByRawTargetId.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const sessionKey = "agent:main:main";
    await trackSessionBrowserTab({ sessionKey, targetId: "closing-client" });
    const onWarn = vi.fn();
    const closeTab = vi.fn<() => Promise<void>>(() => {
      throw new Error("close failed");
    });
    const pending = [closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], onWarn })];
    try {
      await entered.promise;
      pending.push(
        closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab, onWarn }),
      );
    } finally {
      release.resolve();
    }
    await expect(Promise.all(pending)).resolves.toEqual([1, 0]);
    expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("retains node tracking when an opaque handle becomes stale", async () => {
    const closeTarget = vi
      .fn<() => Promise<{ status: "closed" }>>()
      .mockRejectedValueOnce(new Error("404: tab not found"))
      .mockResolvedValueOnce({ status: "closed" });
    const onWarn = vi.fn();
    await trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "chrome-mcp:old-nonce:1",
      profile: "user",
      route: { kind: "node-proxy", nodeId: "node-1", closeTarget },
    });

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"], onWarn }),
    ).resolves.toBe(0);
    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"], onWarn }),
    ).resolves.toBe(1);

    expect(closeTarget).toHaveBeenCalledTimes(2);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringMatching(/failed to close tracked browser tab/i),
    );
  });

  it("coalesces overlapping lifecycle and sweep cleanup for one volatile target", async () => {
    await trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
      profile: "openclaw",
      now: 1_000,
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const closeTab = vi.fn(async () => await closeGate);

    const lifecycle = closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });
    const sweep = sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeTab });
    finishClose();
    const results = await Promise.all([lifecycle, sweep]);

    expect(closeTab).toHaveBeenCalledOnce();
    expect(results.reduce((total, closed) => total + closed, 0)).toBe(1);
  });

  it.each(["lifecycle", "sweep"] as const)(
    "preserves %s activity semantics while cleanup authority prepares",
    async (kind) => {
      const tab = { sessionKey: "agent:main:main", targetId: "active-tab" };
      await trackSessionBrowserTab({ ...tab, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const prepareCurrent = async () => {
        entered.resolve();
        await release.promise;
        return true;
      };
      const cleanup =
        kind === "lifecycle"
          ? closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], prepareCurrent })
          : sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, prepareCurrent });
      try {
        await entered.promise;
        expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
        await touchSessionBrowserTab({ ...tab, now: 11_000 });
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(kind === "lifecycle" ? 1 : 0);
      expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledTimes(
        kind === "lifecycle" ? 1 : 0,
      );
    },
  );

  it("does not adopt a new registration while an earlier selected tab closes", async () => {
    const sessionKey = "agent:main:main";
    const next = { sessionKey, targetId: "next-tab" };
    await trackSessionBrowserTab({ sessionKey, targetId: "first-tab", now: 1_000 });
    await trackSessionBrowserTab({ ...next, now: 1_000 });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const closeTab = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "first-tab") {
        entered.resolve();
        await release.promise;
      }
    });
    const cleanup = closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab });
    try {
      await entered.promise;
      await untrackSessionBrowserTab(next);
      await trackSessionBrowserTab({ ...next, now: 1_000 });
    } finally {
      release.resolve();
    }
    await expect(cleanup).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "next-tab" }));
  });

  it.each(["during-prepare", "before-dispatch", "during-close"] as const)(
    "preserves a registration replaced %s without dispatching against it",
    async (replacementPhase) => {
      const tab = { sessionKey: "agent:main:main", targetId: "replaced-tab" };
      await trackSessionBrowserTab({ ...tab, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let replaced = false;
      const closeTab = vi.fn(async () => {
        expect.soft(replaced).toBe(false);
        entered.resolve();
        await release.promise;
      });
      const cleanup = closeTrackedBrowserTabsForSessions({
        sessionKeys: [tab.sessionKey],
        closeTab: replacementPhase === "during-prepare" ? undefined : closeTab,
        ...(replacementPhase === "during-prepare"
          ? {
              prepareCurrent: async () => {
                await release.promise;
                return true;
              },
            }
          : {}),
      });
      try {
        if (replacementPhase === "during-close") {
          await entered.promise;
        }
        replaced = true;
        await untrackSessionBrowserTab(tab);
        await trackSessionBrowserTab({ ...tab, now: 1_000 });
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(replacementPhase === "during-close" ? 1 : 0);
      expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      const freshClose = vi.fn(async () => {});
      await expect(
        closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab: freshClose }),
      ).resolves.toBe(1);
      expect(freshClose).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retires only acquired cross-session registrations (replace=%s)",
    async (replace) => {
      const first = { sessionKey: "agent:main:first", targetId: "shared-target" };
      const second = { sessionKey: "agent:main:second", targetId: "shared-target" };
      await trackSessionBrowserTab({ ...first, now: 1_000 });
      await trackSessionBrowserTab({ ...second, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const closeTab = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const cleanup = closeTrackedBrowserTabsForSessions({
        sessionKeys: [first.sessionKey],
        closeTab,
      });
      try {
        await entered.promise;
        if (replace) {
          await untrackSessionBrowserTab(second);
          await trackSessionBrowserTab({ ...second, now: 1_000 });
        }
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(1);
      const freshClose = vi.fn(async () => {});
      await expect(
        closeTrackedBrowserTabsForSessions({
          sessionKeys: [second.sessionKey],
          closeTab: freshClose,
        }),
      ).resolves.toBe(replace ? 1 : 0);
      expect(freshClose).toHaveBeenCalledTimes(replace ? 1 : 0);
    },
  );

  it("isolates volatile aliases by browser surface", async () => {
    await trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9001" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    await trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-B",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9002" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    await touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9001" },
      profile: "openclaw",
      now: 9_000,
    });
    const closeTab = vi.fn(async () => {});

    await expect(sweepTrackedBrowserTabs({ now: 10_000, idleMs: 5_000, closeTab })).resolves.toBe(
      1,
    );
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "RAW-B",
      baseUrl: "http://127.0.0.1:9002",
      profile: "openclaw",
    });
  });

  it("retries transient close failures and retires missing targets", async () => {
    await trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "missing" });
    await trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "transient" });
    const warnings: string[] = [];
    const firstClose = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "missing") {
        throw new Error("No target with given id found");
      }
      throw new Error("network down");
    });

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: firstClose,
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(0);
    expect(warnings).toEqual([
      "failed to close tracked browser tab transient: Error: network down",
    ]);

    const retryClose = vi.fn(async () => {});
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: retryClose,
      }),
    ).resolves.toBe(1);
    expect(retryClose).toHaveBeenCalledWith({
      targetId: "transient",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("caps each session by least-recently-used order and honors session filters", async () => {
    vi.setSystemTime(1_000);
    await trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    vi.setSystemTime(2_000);
    await trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-b" });
    vi.setSystemTime(3_000);
    await trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-c" });
    await trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "child-tab",
    });
    const closeTab = vi.fn(async () => {});

    await expect(
      sweepTrackedBrowserTabs({
        now: 4_000,
        maxTabsPerSession: 2,
        sessionFilter: (sessionKey) => !sessionKey.includes(":subagent:"),
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-a",
      baseUrl: undefined,
      profile: undefined,
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:subagent:child"],
        closeTab: async () => {},
      }),
    ).resolves.toBe(1);
  });
});

const processStateSymbols = [
  "openclaw.browser.session-tabs.volatile",
  "openclaw.browser.session-tabs.volatile-cleanup",
  "openclaw.browser.session-tabs.volatile-aliases",
  "openclaw.browser.session-tabs.exact-volatile-aliases",
  "openclaw.browser.session-tabs.deferred-diagnostics",
];

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of processStateSymbols) {
    delete state[Symbol.for(name)];
  }
}

describe("volatile session tab cleanup across Browser plugin bundles", () => {
  let freshModuleCounter = 0;

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?concurrent=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(clearProcessLocalTabState);
  afterEach(clearProcessLocalTabState);

  it("preserves volatile tabs when an untyped caller omits native-check preparation", async () => {
    const registry = await freshRegistry("unpaired-current");
    const sessionKey = "agent:main:main";
    await registry.trackSessionBrowserTab({
      sessionKey,
      targetId: "unpaired-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
    });
    const closeTab = vi.fn<CloseTab>(async () => {});
    const onWarn = vi.fn();
    await expect(
      Reflect.apply(registry.closeTrackedBrowserTabsForSessions.bind(registry), undefined, [
        {
          sessionKeys: [sessionKey],
          sessionEntryCurrent: {
            source: {
              agentId: "main",
              path: "/synthetic/agent.sqlite",
              sessionKey,
              databaseIdentity: "synthetic-source",
            },
            assertCurrent: vi.fn(),
          },
          closeTab,
          onWarn,
        },
      ]),
    ).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledExactlyOnceWith(
      "browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent",
    );
    await expect(
      registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("keeps a replacement registration when a waiting cleanup caller becomes stale", async () => {
    const first = await freshRegistry("first-owner");
    const follower = await freshRegistry("waiting-owner");
    const tab = {
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const,
      profile: "remote",
    };
    await first.trackSessionBrowserTab(tab);
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const closeTab = vi.fn<CloseTab>(async () => {
      started.resolve();
      await finish.promise;
    });
    let current = true;
    const params = { sessionKeys: [tab.sessionKey], closeTab, isCurrent: () => current };
    const closing = first.closeTrackedBrowserTabsForSessions(params);
    await started.promise;
    await follower.trackSessionBrowserTab(tab);
    const waiting = follower.closeTrackedBrowserTabsForSessions(params);
    try {
      current = false;
      finish.resolve();
      await expect(Promise.all([closing, waiting])).resolves.toEqual([1, 0]);
      expect(closeTab).toHaveBeenCalledOnce();
      await expect(
        follower.closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab }),
      ).resolves.toBe(1);
      expect(closeTab).toHaveBeenCalledTimes(2);
    } finally {
      finish.resolve();
      await Promise.all([closing, waiting]);
    }
  });

  it("shares one close attempt and releases a failed reservation for retry", async () => {
    const first = await freshRegistry("first");
    const duplicate = await freshRegistry("duplicate");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
    });

    let failClose!: () => void;
    const failedClose = new Promise<void>((_resolve, reject) => {
      failClose = () => reject(new Error("network down"));
    });
    const closeTab = vi.fn<CloseTab>(async () => await failedClose);
    const onWarn = vi.fn();
    const firstAttempts = [first, duplicate].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
        onWarn,
      }),
    );
    failClose();
    await expect(Promise.all(firstAttempts)).resolves.toEqual([0, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledOnce();

    let finishRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const retry = vi.fn<CloseTab>(async () => await retryGate);
    const retries = [duplicate, first].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: retry,
      }),
    );
    finishRetry();
    const retryResults = await Promise.all(retries);

    expect(retry).toHaveBeenCalledOnce();
    expect(retryResults.reduce((total, closed) => total + closed, 0)).toBe(1);
  });
});
