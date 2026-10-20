import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SessionEntryCurrentPreparation } from "openclaw/plugin-sdk/plugin-state-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloseTab } from "./session-tab-registry.sqlite.test-helpers.js";

const closeClient = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./client-tab-close.runtime.js", () => ({ browserCloseTabByRawTargetId: closeClient }));

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

const controlRoute = (port: number) => ({
  kind: "browser-control" as const,
  baseUrl: `http://127.0.0.1:${port}`,
});
const surface = (port: number) => ({ route: controlRoute(port), profile: "openclaw" });
const bundleTab = {
  sessionKey,
  targetId: "bridge-tab",
  route: controlRoute(9999),
  profile: "remote",
};

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
  const prepareCurrent = () => wait().then(() => true);
  return { entered, release, wait, prepareCurrent };
}

type CleanupGate = ReturnType<typeof closeGate>;
async function whileClosing(gate: CleanupGate, action: () => void | Promise<void>) {
  try {
    await gate.entered.promise;
    await action();
  } finally {
    gate.release.resolve();
  }
}

async function track(targetId: string, params: TrackParams = {}) {
  const tab = { sessionKey, targetId, now: 1_000, ...params };
  if (tab.sessionKey) {
    trackedSessionKeys.add(tab.sessionKey);
  }
  await trackSessionBrowserTabRuntime(tab);
  return tab;
}

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    closeClient.mockClear();
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
    closeClient.mockImplementationOnce(gate.wait);
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
    expect(closeClient).toHaveBeenCalledOnce();
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
    await track("shared-tab", { route: controlRoute(9222), profile: "openclaw" });
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
    const tab = await track("touched-during-sweep", { route: controlRoute(9222) });
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

  it.each(["lifecycle", "sweep"] as const)("keeps %s activity semantics", async (kind) => {
    const tab = await track("active-tab");
    const gate = closeGate();
    const { prepareCurrent } = gate;
    const cleanup =
      kind === "lifecycle"
        ? close({ prepareCurrent })
        : sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, prepareCurrent });
    await whileClosing(gate, async () => {
      expect(closeClient).not.toHaveBeenCalled();
      await touchSessionBrowserTab({ ...tab, now: 11_000 });
    });
    await expect(cleanup).resolves.toBe(kind === "lifecycle" ? 1 : 0);
    expect(closeClient).toHaveBeenCalledTimes(kind === "lifecycle" ? 1 : 0);
  });

  it.each(["prepare", "dispatch", "close", "earlier-close"] as const)(
    "preserves a replaced registration (%s)",
    async (phase) => {
      if (phase === "earlier-close") {
        await track("first-tab");
      }
      const tab = await track("replaced-tab");
      const { entered, release, wait } = closeGate();
      let replaced = false;
      const closeTab = vi.fn(async ({ targetId }: { targetId: string }) => {
        if (phase !== "earlier-close") {
          expect.soft(replaced).toBe(false);
        }
        if (phase !== "earlier-close" || targetId === "first-tab") {
          await wait();
        }
      });
      const cleanup = close({
        closeTab: phase === "prepare" ? undefined : closeTab,
        prepareCurrent:
          phase === "prepare"
            ? async () => {
                await release.promise;
                return true;
              }
            : undefined,
      });
      try {
        if (phase === "close" || phase === "earlier-close") {
          await entered.promise;
        }
        replaced = true;
        await untrackSessionBrowserTab(tab);
        await track(tab.targetId, tab);
      } finally {
        release.resolve();
      }
      const admitted = phase === "close" || phase === "earlier-close";
      await expect(cleanup).resolves.toBe(admitted ? 1 : 0);
      expect(closeTab).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(closeClient).not.toHaveBeenCalled();
      const freshClose = phase === "earlier-close" ? closeTab : vi.fn(async () => {});
      await expectClosed(1, { closeTab: freshClose });
      expect(freshClose).toHaveBeenCalledTimes(phase === "earlier-close" ? 2 : 1);
      expect(freshClose).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetId: tab.targetId }),
      );
    },
  );

  it.each([false, true])("retires only acquired registrations (replace=%s)", async (replace) => {
    const first = await track("shared-target", { sessionKey: "agent:main:first" });
    const second = await track("shared-target", { sessionKey: "agent:main:second" });
    const gate = closeGate();
    const closeTab = vi.fn(gate.wait);
    const cleanup = close({ sessionKeys: [first.sessionKey], closeTab });
    await whileClosing(gate, async () => {
      if (replace) {
        await untrackSessionBrowserTab(second);
        await track(second.targetId, second);
      }
    });
    await expect(cleanup).resolves.toBe(1);
    const freshClose = vi.fn(async () => {});
    await expectClosed(replace ? 1 : 0, {
      sessionKeys: [second.sessionKey],
      closeTab: freshClose,
    });
    expect(freshClose).toHaveBeenCalledTimes(replace ? 1 : 0);
  });

  it("isolates volatile aliases by browser surface", async () => {
    const first = await track("RAW-A", { ...surface(9001), aliases: ["shared"] });
    await track("RAW-B", { ...surface(9002), aliases: ["shared"] });
    await touchSessionBrowserTab({
      ...first,
      targetId: "shared",
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
    await track("tab-a");
    await track("tab-b", { now: 2_000 });
    await track("tab-c", { now: 3_000 });
    await track("child-tab", { sessionKey: "agent:main:subagent:child", now: 3_000 });
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
    await expectClosed(1, { sessionKeys: ["agent:main:subagent:child"], closeTab: async () => {} });
  });
});

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.volatile-cleanup",
    "openclaw.browser.session-tabs.volatile-aliases",
    "openclaw.browser.session-tabs.exact-volatile-aliases",
    "openclaw.browser.session-tabs.deferred-diagnostics",
  ]) {
    delete state[Symbol.for(name)];
  }
}

describe("volatile session tab cleanup across Browser plugin bundles", () => {
  let freshModuleCounter = 0;

  async function freshRegistry(label: string) {
    freshModuleCounter += 1;
    const registry = await importFreshModule<typeof import("./session-tab-registry.js")>(
      import.meta.url,
      `./session-tab-registry.js?concurrent=${label}-${freshModuleCounter}`,
    );
    return {
      ...registry,
      track: () => registry.trackSessionBrowserTab(bundleTab),
      close: (params: CloseOptions = {}) =>
        registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], ...params }),
    };
  }

  beforeEach(clearProcessLocalTabState);
  afterEach(clearProcessLocalTabState);

  it("preserves volatile tabs when an untyped caller omits native-check preparation", async () => {
    const registry = await freshRegistry("unpaired-current");
    await registry.trackSessionBrowserTab({
      sessionKey,
      targetId: "unpaired-tab",
      route: controlRoute(9999),
    });
    const closeTab = vi.fn<CloseTab>(async () => {});
    const onWarn = vi.fn();
    const unpaired = { sessionKeys: [sessionKey], sessionEntryCurrent: {}, closeTab, onWarn };
    await expect(
      Reflect.apply(registry.closeTrackedBrowserTabsForSessions, registry, [unpaired]),
    ).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledExactlyOnceWith(
      "browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent",
    );
    await expect(registry.close({ closeTab })).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("keeps a replacement registration when a waiting cleanup caller becomes stale", async () => {
    const first = await freshRegistry("first-owner");
    const follower = await freshRegistry("waiting-owner");
    await first.track();
    const { entered: started, release: finish, wait } = closeGate();
    const closeTab = vi.fn<CloseTab>(wait);
    let current = true;
    const params = { closeTab, isCurrent: () => current };
    const closing = first.close(params);
    await started.promise;
    await follower.track();
    const waiting = follower.close(params);
    try {
      current = false;
      finish.resolve();
      await expect(Promise.all([closing, waiting])).resolves.toEqual([1, 0]);
      expect(closeTab).toHaveBeenCalledOnce();
      await expect(follower.close({ closeTab })).resolves.toBe(1);
      expect(closeTab).toHaveBeenCalledTimes(2);
    } finally {
      finish.resolve();
      await Promise.all([closing, waiting]);
    }
  });

  it("shares one close attempt and releases a failed reservation for retry", async () => {
    const first = await freshRegistry("first");
    const duplicate = await freshRegistry("duplicate");
    await first.track();

    const failedClose = createDeferred<void>();
    const closeTab = vi.fn<CloseTab>(async () => await failedClose.promise);
    const onWarn = vi.fn();
    const firstAttempts = [first, duplicate].map((reg) => reg.close({ closeTab, onWarn }));
    failedClose.reject(new Error("network down"));
    await expect(Promise.all(firstAttempts)).resolves.toEqual([0, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledOnce();

    const retryGate = createDeferred<void>();
    const retry = vi.fn<CloseTab>(async () => await retryGate.promise);
    const retries = [duplicate, first].map((registry) => registry.close({ closeTab: retry }));
    retryGate.resolve();
    const retryResults = await Promise.all(retries);

    expect(retry).toHaveBeenCalledOnce();
    expect(retryResults.reduce((total, closed) => total + closed, 0)).toBe(1);
  });
});
