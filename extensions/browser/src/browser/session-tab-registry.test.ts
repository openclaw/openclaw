// Browser tests cover session tab registry plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countTrackedSessionBrowserTabsForTests,
  getTrackedSessionBrowserTabsForTests,
  resetTrackedSessionBrowserTabsForTests,
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTrackedSessionBrowserTabsForTests();
  });

  afterEach(() => {
    resetTrackedSessionBrowserTabsForTests();
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
    expect(countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);

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
    expect(countTrackedSessionBrowserTabsForTests()).toBe(0);
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
    expect(countTrackedSessionBrowserTabsForTests()).toBe(0);
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
    expect(countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(1);
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
    expect(countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);
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
    expect(countTrackedSessionBrowserTabsForTests()).toBe(1);
  });

  it("does not persist Browser Steward tab metadata without an allowed runtime decision", () => {
    trackSessionBrowserTab({
      sessionKey: "agent:browser-session-credential-steward:runtime-check",
      targetId: "tab-denied",
      profile: "user",
    });

    expect(
      countTrackedSessionBrowserTabsForTests(
        "agent:browser-session-credential-steward:runtime-check",
      ),
    ).toBe(0);
  });

  it("does not treat other agent ids containing the steward name as Browser Steward sessions", () => {
    trackSessionBrowserTab({
      sessionKey: "agent:not-browser-session-credential-steward:runtime-check",
      targetId: "tab-allowed",
      profile: "user",
    });

    expect(
      countTrackedSessionBrowserTabsForTests(
        "agent:not-browser-session-credential-steward:runtime-check",
      ),
    ).toBe(1);
  });

  it("persists only redacted Browser Steward runtime guard metadata", () => {
    trackSessionBrowserTab({
      sessionKey: "agent:browser-session-credential-steward:runtime-check",
      targetId: "tab-approved",
      profile: "user",
      browserStewardRuntimeDecision: {
        boundaryDecision: "allow",
        requestedAction: "open",
        affectedBrowserProfile: "user",
        affectedSession: "agent:browser-session-credential-steward:REDACTED",
        sessionBoundary: {
          kind: "browser_steward",
          ownerAgentId: "browser-session-credential-steward",
          affectedSession: "agent:browser-session-credential-steward:REDACTED",
        },
        credentialExposureKind: "none",
        credentialExposureReasonCode: "no_credential_material",
        credentialClassesInvolved: ["browser session"],
        dataSensitivity: "high",
        approvalRequired: false,
        safeNextAction: "proceed with redacted Browser Steward runtime guard metadata",
        telemetryEvent: "browser_steward.boundary_decision",
      },
    });

    const tracked = getTrackedSessionBrowserTabsForTests(
      "agent:browser-session-credential-steward:runtime-check",
    );
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({
      targetId: "tab-approved",
      profile: "user",
      browserStewardRuntimeGuard: {
        boundaryDecision: "allow",
        requestedAction: "open",
        affectedBrowserProfile: "user",
        affectedSession: "agent:browser-session-credential-steward:REDACTED",
        sessionBoundary: {
          kind: "browser_steward",
          ownerAgentId: "browser-session-credential-steward",
          affectedSession: "agent:browser-session-credential-steward:REDACTED",
        },
        approvalSource: "runtime",
        telemetryEvent: "browser_steward.boundary_decision",
      },
    });
    expect(JSON.stringify(tracked[0]?.browserStewardRuntimeGuard)).not.toContain("runtime-check");
    expect(JSON.stringify(tracked[0]?.browserStewardRuntimeGuard)).not.toMatch(
      /password|token|cookie|secret|privateKey|apiKey/i,
    );
  });
});
