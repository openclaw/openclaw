import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SessionEntryCurrentPreparation } from "openclaw/plugin-sdk/plugin-state-runtime";
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
const sessionKey = "agent:main:main";
type TrackParams = Parameters<typeof trackSessionBrowserTabRuntime>[0];
type CloseParams = Parameters<typeof closeTrackedBrowserTabsForSessions>[0];
type CloseOptions = Omit<CloseParams, "sessionKeys"> &
  SessionEntryCurrentPreparation & { sessionKeys?: CloseParams["sessionKeys"] };

function close(params: CloseOptions = {}) {
  return closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], ...params });
}

function expectClosed(count: number, params: CloseOptions = {}) {
  return expect(close(params)).resolves.toBe(count);
}

function closeGate() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const wait = () => {
    entered.resolve();
    return release.promise;
  };
  const prepareCurrent = async () => {
    await wait();
    return true;
  };
  return { entered, release, wait, prepareCurrent };
}

async function whileClosing(
  gate: ReturnType<typeof closeGate>,
  action: () => void | Promise<void>,
) {
  try {
    await gate.entered.promise;
    await action();
  } finally {
    gate.release.resolve();
  }
}

function track(targetId: string, params: TrackParams = {}) {
  const tab = { sessionKey, targetId, ...params };
  if (tab.sessionKey) {
    trackedSessionKeys.add(tab.sessionKey);
  }
  return trackSessionBrowserTabRuntime(tab);
}

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientMocks.browserCloseTabByRawTargetId.mockClear();
    trackedSessionKeys.clear();
  });

  afterEach(async () => {
    await close({
      sessionKeys: [...trackedSessionKeys],
      closeTab: async () => {},
    });
    vi.useRealTimers();
  });

  it("reserves cleanup while its client closes before an overlapping closer can fail", async () => {
    const gate = closeGate();
    clientMocks.browserCloseTabByRawTargetId.mockImplementationOnce(gate.wait);
    await track("closing-client");
    const onWarn = vi.fn();
    const closeTab = vi.fn<() => Promise<void>>(() => {
      throw new Error("close failed");
    });
    const pending = [close({ onWarn })];
    await whileClosing(gate, () => {
      pending.push(close({ closeTab, onWarn }));
    });
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
    await track("chrome-mcp:old-nonce:1", {
      profile: "user",
      route: { kind: "node-proxy", nodeId: "node-1", closeTarget },
    });

    await expectClosed(0, { onWarn });
    await expectClosed(1, { onWarn });

    expect(closeTarget).toHaveBeenCalledTimes(2);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringMatching(/failed to close tracked browser tab/i),
    );
  });

  it("coalesces overlapping lifecycle and sweep cleanup for one volatile target", async () => {
    await track("shared-tab", {
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
      profile: "openclaw",
      now: 1_000,
    });
    const gate = createDeferred<void>();
    const closeTab = vi.fn(async () => await gate.promise);

    const lifecycle = close({ closeTab });
    const sweep = sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeTab });
    gate.resolve();
    const results = await Promise.all([lifecycle, sweep]);

    expect(closeTab).toHaveBeenCalledOnce();
    expect(results.reduce((total, closed) => total + closed, 0)).toBe(1);
  });

  it("preserves lifecycle cleanup after activity cancels a shared sweep", async () => {
    const tab = {
      sessionKey,
      targetId: "touched-during-sweep",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" } as const,
    };
    await track(tab.targetId, { ...tab, now: 1_000 });
    const gate = closeGate();
    const closeTab = vi.fn(async () => {});
    const sweep = sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeTab,
      prepareCurrent: gate.prepareCurrent,
    });
    const lifecycle: Array<Promise<number>> = [];
    await whileClosing(gate, async () => {
      lifecycle.push(close({ closeTab }), close({ closeTab }));
      await touchSessionBrowserTab({ ...tab, now: 11_000 });
    });
    await expect(sweep).resolves.toBe(0);
    const results = await Promise.all(lifecycle);
    expect(results.reduce((total, closed) => total + closed, 0)).toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    await expectClosed(0, { closeTab });
  });

  it.each(["lifecycle", "sweep"] as const)(
    "preserves %s activity semantics while cleanup authority prepares",
    async (kind) => {
      const tab = { sessionKey, targetId: "active-tab" };
      await track(tab.targetId, { ...tab, now: 1_000 });
      const gate = closeGate();
      const { prepareCurrent } = gate;
      const cleanup =
        kind === "lifecycle"
          ? close({ prepareCurrent })
          : sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, prepareCurrent });
      await whileClosing(gate, async () => {
        expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
        await touchSessionBrowserTab({ ...tab, now: 11_000 });
      });
      await expect(cleanup).resolves.toBe(kind === "lifecycle" ? 1 : 0);
      expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledTimes(
        kind === "lifecycle" ? 1 : 0,
      );
    },
  );

  it("does not adopt a new registration while an earlier selected tab closes", async () => {
    const next = { sessionKey, targetId: "next-tab" };
    await track("first-tab", { now: 1_000 });
    await track(next.targetId, { ...next, now: 1_000 });
    const gate = closeGate();
    const closeTab = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "first-tab") {
        await gate.wait();
      }
    });
    const cleanup = close({ closeTab });
    await whileClosing(gate, async () => {
      await untrackSessionBrowserTab(next);
      await track(next.targetId, { ...next, now: 1_000 });
    });
    await expect(cleanup).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    await expectClosed(1, { closeTab });
    expect(closeTab).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "next-tab" }));
  });

  it.each(["during-prepare", "before-dispatch", "during-close"] as const)(
    "preserves a registration replaced %s without dispatching against it",
    async (replacementPhase) => {
      const tab = { sessionKey, targetId: "replaced-tab" };
      await track(tab.targetId, { ...tab, now: 1_000 });
      const { entered, release, wait } = closeGate();
      let replaced = false;
      const closeTab = vi.fn(async () => {
        expect.soft(replaced).toBe(false);
        await wait();
      });
      const cleanup = close({
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
        await track(tab.targetId, { ...tab, now: 1_000 });
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(replacementPhase === "during-close" ? 1 : 0);
      expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      const freshClose = vi.fn(async () => {});
      await expectClosed(1, { closeTab: freshClose });
      expect(freshClose).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retires only acquired cross-session registrations (replace=%s)",
    async (replace) => {
      const first = { sessionKey: "agent:main:first", targetId: "shared-target" };
      const second = { sessionKey: "agent:main:second", targetId: "shared-target" };
      await track(first.targetId, { ...first, now: 1_000 });
      await track(second.targetId, { ...second, now: 1_000 });
      const gate = closeGate();
      const closeTab = vi.fn(gate.wait);
      const cleanup = close({
        sessionKeys: [first.sessionKey],
        closeTab,
      });
      await whileClosing(gate, async () => {
        if (replace) {
          await untrackSessionBrowserTab(second);
          await track(second.targetId, { ...second, now: 1_000 });
        }
      });
      await expect(cleanup).resolves.toBe(1);
      const freshClose = vi.fn(async () => {});
      await expectClosed(replace ? 1 : 0, {
        sessionKeys: [second.sessionKey],
        closeTab: freshClose,
      });
      expect(freshClose).toHaveBeenCalledTimes(replace ? 1 : 0);
    },
  );

  it("isolates volatile aliases by browser surface", async () => {
    await track("RAW-A", {
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9001" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    await track("RAW-B", {
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9002" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    await touchSessionBrowserTab({
      sessionKey,
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
    await track("missing");
    await track("transient");
    const warnings: string[] = [];
    const firstClose = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "missing") {
        throw new Error("No target with given id found");
      }
      throw new Error("network down");
    });

    await expectClosed(0, { closeTab: firstClose, onWarn: (message) => warnings.push(message) });
    expect(warnings).toEqual([
      "failed to close tracked browser tab transient: Error: network down",
    ]);

    const retryClose = vi.fn(async () => {});
    await expectClosed(1, { closeTab: retryClose });
    expect(retryClose).toHaveBeenCalledWith({
      targetId: "transient",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("caps each session by least-recently-used order and honors session filters", async () => {
    vi.setSystemTime(1_000);
    await track("tab-a");
    vi.setSystemTime(2_000);
    await track("tab-b");
    vi.setSystemTime(3_000);
    await track("tab-c");
    await track("child-tab", {
      sessionKey: "agent:main:subagent:child",
    });
    const closeTab = vi.fn(async () => {});

    await expect(
      sweepTrackedBrowserTabs({
        now: 4_000,
        maxTabsPerSession: 2,
        sessionFilter: (key) => !key.includes(":subagent:"),
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-a",
      baseUrl: undefined,
      profile: undefined,
    });
    await expectClosed(1, {
      sessionKeys: ["agent:main:subagent:child"],
      closeTab: async () => {},
    });
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
      sessionKey,
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const,
      profile: "remote",
    };
    await first.trackSessionBrowserTab(tab);
    const { entered: started, release: finish, wait } = closeGate();
    const closeTab = vi.fn<CloseTab>(wait);
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
      sessionKey,
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
    });

    const failedClose = createDeferred<void>();
    const closeTab = vi.fn<CloseTab>(async () => await failedClose.promise);
    const onWarn = vi.fn();
    const firstAttempts = [first, duplicate].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab,
        onWarn,
      }),
    );
    failedClose.reject(new Error("network down"));
    await expect(Promise.all(firstAttempts)).resolves.toEqual([0, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledOnce();

    const retryGate = createDeferred<void>();
    const retry = vi.fn<CloseTab>(async () => await retryGate.promise);
    const retries = [duplicate, first].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab: retry,
      }),
    );
    retryGate.resolve();
    const retryResults = await Promise.all(retries);

    expect(retry).toHaveBeenCalledOnce();
    expect(retryResults.reduce((total, closed) => total + closed, 0)).toBe(1);
  });
});
