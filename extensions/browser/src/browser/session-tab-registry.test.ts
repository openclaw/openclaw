// Browser tests cover session tab registry plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
}));

vi.mock("./client.js", () => clientMocks);

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
  trackSessionBrowserTabRuntime(params);
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

  it("tracks and closes tabs for normalized session keys", async () => {
    trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(2);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).toHaveBeenNthCalledWith(1, {
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
    expect(closeTab).toHaveBeenNthCalledWith(2, {
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
  });

  it("closes tracked tabs through the raw target-id client path", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW_TARGET",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
    ).resolves.toBe(1);

    expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      "RAW_TARGET",
      { profile: "openclaw" },
    );
  });

  it("untracks specific tabs", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
    });
    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-b",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("does not close unknown user tabs without a tracking record", async () => {
    const closeTab = vi.fn(async () => {});

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(0);

    expect(closeTab).not.toHaveBeenCalled();
  });

  it("touches one non-durable tab through any same-process open alias", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "openclaw",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
      aliases: ["RAW-A", "t1", "docs", "docs"],
      now: 1_000,
    });

    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "openclaw",
      now: 9_000,
    });
    const closeTab = vi.fn(async () => {});
    await expect(
      sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 5_000,
        closeTab,
      }),
    ).resolves.toBe(0);
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "RAW-A",
      profile: "openclaw",
    });
  });

  it("untracks a non-durable tab and all aliases through one alias", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "openclaw",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
      aliases: ["RAW-A", "t1", "docs"],
    });

    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "t1",
      profile: "openclaw",
    });
    const closeTab = vi.fn(async () => {});
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("waits for an in-flight volatile sweep before lifecycle cleanup rechecks state", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "openclaw",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
      aliases: ["RAW-A", "docs"],
      now: 1_000,
    });
    let releaseSweepClose: (() => void) | undefined;
    let markSweepCloseStarted: (() => void) | undefined;
    const sweepCloseStarted = new Promise<void>((resolve) => {
      markSweepCloseStarted = resolve;
    });
    const sweepCloseGate = new Promise<void>((resolve) => {
      releaseSweepClose = resolve;
    });
    const closeTab = vi.fn(async () => {
      markSweepCloseStarted?.();
      await sweepCloseGate;
    });
    const sweep = sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeTab,
    });
    await sweepCloseStarted;

    let lifecycleSettled = false;
    const lifecycle = closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    }).finally(() => {
      lifecycleSettled = true;
    });
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    const settledBeforeSweep = lifecycleSettled;
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "openclaw",
      now: 11_000,
    });
    releaseSweepClose?.();

    await expect(Promise.all([sweep, lifecycle])).resolves.toEqual([1, 0]);
    expect(settledBeforeSweep).toBe(false);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("retries volatile lifecycle cleanup when the waited sweep leaves the tab tracked", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "openclaw",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
      aliases: ["RAW-A", "docs"],
      now: 1_000,
    });
    let releaseSweepClose: (() => void) | undefined;
    let markSweepCloseStarted: (() => void) | undefined;
    const sweepCloseStarted = new Promise<void>((resolve) => {
      markSweepCloseStarted = resolve;
    });
    const sweepCloseGate = new Promise<void>((resolve) => {
      releaseSweepClose = resolve;
    });
    let closeAttempts = 0;
    const closeTab = vi.fn(async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) {
        markSweepCloseStarted?.();
        await sweepCloseGate;
        throw new Error("sweep close failed");
      }
    });
    const sweep = sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeTab,
    });
    await sweepCloseStarted;
    const lifecycle = closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "openclaw",
      now: 11_000,
    });
    releaseSweepClose?.();

    await expect(Promise.all([sweep, lifecycle])).resolves.toEqual([0, 1]);
    expect(closeTab).toHaveBeenCalledTimes(2);
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(0);
  });

  it("deduplicates tabs and ignores expected close errors", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-b",
    });
    const warnings: string[] = [];
    const closeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("target not found"))
      .mockRejectedValueOnce(new Error("network down"));

    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main", "main"],
      closeTab,
      onWarn: (message) => warnings.push(message),
    });

    expect(closed).toBe(0);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual(["failed to close tracked browser tab tab-b: Error: network down"]);
  });

  it("sweeps idle tracked tabs and keeps recently touched tabs", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "old-tab",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "active-tab",
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "active-tab",
      now: 11_000,
    });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 11_000,
      idleMs: 5_000,
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "old-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: async () => {},
      }),
    ).resolves.toBe(1);
  });

  it("caps tracked tabs per session by closing least recently used tabs first", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    vi.setSystemTime(2_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-b" });
    vi.setSystemTime(3_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-c" });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 4_000,
      maxTabsPerSession: 2,
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-a",
      baseUrl: undefined,
      profile: undefined,
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: async () => {},
      }),
    ).resolves.toBe(2);
  });

  it("honors session filters during sweeps", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "primary-tab" });
    trackSessionBrowserTab({ sessionKey: "agent:main:subagent:child", targetId: "child-tab" });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      sessionFilter: (sessionKey) => !sessionKey.includes(":subagent:"),
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "primary-tab",
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
