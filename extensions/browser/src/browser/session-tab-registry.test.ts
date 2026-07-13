// Browser tests cover session tab registry plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
}));

vi.mock("./client.js", () => clientMocks);

import {
  acquireTrackedBrowserSessionAccess,
  claimTrackedBrowserSessionOwner,
  countTrackedSessionBrowserTabsForTests,
  resetTrackedSessionBrowserTabsForTests,
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
    resetTrackedSessionBrowserTabsForTests();
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

  it("closes only tabs owned by the completed run and preserves successor tabs", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "old-tab",
      ownerId: "run-old",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "successor-tab",
      ownerId: "run-successor",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "legacy-tab",
    });
    const closeTab = vi.fn(async () => {});

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:subagent:child"],
        ownerId: "run-old",
        closeTab,
      }),
    ).resolves.toBe(2);

    expect(closeTab).toHaveBeenCalledWith({
      targetId: "old-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "legacy-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    expect(countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(1);
  });

  it("transfers ownership when a successor reuses an existing tab", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "reused-tab",
      ownerId: "run-old",
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "reused-tab",
      ownerId: "run-successor",
    });
    const closeTab = vi.fn(async () => {});

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      ownerId: "run-old",
      closeTab,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(1);
  });

  it("ignores a late predecessor callback after a successor claim", async () => {
    const oldClaim = claimTrackedBrowserSessionOwner({
      sessionKey: "agent:main:subagent:child",
      ownerId: "run-old",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "reused-tab",
      ownerId: "run-old",
      ownerClaim: oldClaim,
    });
    const successorClaim = claimTrackedBrowserSessionOwner({
      sessionKey: "agent:main:subagent:child",
      ownerId: "run-successor",
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "reused-tab",
      ownerId: "run-successor",
      ownerClaim: successorClaim,
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "reused-tab",
      ownerId: "run-old",
      ownerClaim: oldClaim,
    });
    const closeTab = vi.fn(async () => {});

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      ownerId: "run-old",
      closeTab,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(1);
  });

  it("drops a blocked predecessor alias so the successor can retire the tab", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:old-alias",
      targetId: "shared-tab",
      ownerId: "run-old",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:new-alias",
      targetId: "shared-tab",
      ownerId: "run-successor",
    });
    const closeTab = vi.fn(async () => {});

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:old-alias", "agent:main:new-alias"],
      ownerId: "run-old",
      closeTab,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(countTrackedSessionBrowserTabsForTests("agent:main:old-alias")).toBe(0);
    expect(countTrackedSessionBrowserTabsForTests("agent:main:new-alias")).toBe(1);

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:new-alias"],
      ownerId: "run-successor",
      closeTab,
    });
    expect(closeTab).toHaveBeenCalledOnce();
    expect(countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  it("waits for active browser access before closing and blocks successor access", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "old-tab",
      ownerId: "run-old",
    });
    const releaseActiveAccess = await acquireTrackedBrowserSessionAccess({
      sessionKey: "agent:main:subagent:child",
    });
    let releaseClose: (() => void) | undefined;
    const closeTab = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const cleanup = closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      ownerId: "run-old",
      closeTab,
    });

    await Promise.resolve();
    expect(closeTab).not.toHaveBeenCalled();
    releaseActiveAccess();
    await vi.waitFor(() => expect(closeTab).toHaveBeenCalledOnce());

    let successorAccessStarted = false;
    const successorAccess = acquireTrackedBrowserSessionAccess({
      sessionKey: "agent:main:subagent:child",
    }).then((release) => {
      successorAccessStarted = true;
      return release;
    });
    await Promise.resolve();
    expect(successorAccessStarted).toBe(false);

    releaseClose?.();
    await cleanup;
    const releaseSuccessorAccess = await successorAccess;
    releaseSuccessorAccess();
    expect(successorAccessStarted).toBe(true);
  });

  it("keeps failed closes tracked for a later cleanup", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "tab-a",
      ownerId: "run-old",
    });
    const closeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("browser unavailable"))
      .mockResolvedValueOnce(undefined);

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      ownerId: "run-old",
      closeTab,
    });
    expect(countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(1);

    await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:subagent:child"],
      ownerId: "run-old",
      closeTab,
    });
    expect(countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(0);
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
    expect(countTrackedSessionBrowserTabsForTests()).toBe(1);
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
