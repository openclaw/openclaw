import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserServerState } from "./server-context.js";

type MockChromeBrowserAuthHealth = {
  level: "high" | "medium" | "low";
  attached: boolean;
  mcpPid: number | null;
  port: number | null;
  browserUuid: string | null;
  reasons: string[];
  emptyState: boolean;
  cacheAttached: boolean;
};
function makeAttached(mcpPid: number | null = 4321): MockChromeBrowserAuthHealth {
  return {
    level: "high",
    attached: true,
    mcpPid,
    port: null,
    browserUuid: null,
    reasons: ["cache:mcp-session-ready"],
    emptyState: false,
    cacheAttached: true,
  };
}
function makeUnattached(
  level: "low" | "medium" = "low",
  emptyState = true,
): MockChromeBrowserAuthHealth {
  return {
    level,
    attached: false,
    mcpPid: null,
    port: null,
    browserUuid: null,
    reasons: [`file:${level === "low" ? "user-enabled-false" : "lsof-timeout"}`],
    emptyState,
    cacheAttached: false,
  };
}
type MockStartGateDecision =
  | { mayStart: true; reason: string }
  | { mayStart: false; reason: string; level: "high" | "medium" | "low" };

const chromeMcpMock = vi.hoisted(() => {
  return {
    closeChromeMcpSession: vi.fn(async () => true),
    ensureChromeMcpAvailable: vi.fn(async () => {}),
    focusChromeMcpTab: vi.fn(async () => {}),
    listChromeMcpTabs: vi.fn(async () => [
      { targetId: "7", title: "", url: "https://example.com", type: "page" },
    ]),
    openChromeMcpTab: vi.fn(async () => ({
      targetId: "8",
      title: "",
      url: "about:blank",
      type: "page",
    })),
    closeChromeMcpTab: vi.fn(async () => {}),
    getChromeMcpPid: vi.fn(() => 4321),
    probeChromeMcpHealth: vi.fn(
      async (): Promise<{
        level: "high" | "medium" | "low";
        attached: boolean;
        mcpPid: number | null;
        port: number | null;
        browserUuid: string | null;
        reasons: string[];
        emptyState: boolean;
        cacheAttached: boolean;
      }> => ({
        level: "high",
        attached: true,
        mcpPid: 4321,
        port: null,
        browserUuid: null,
        reasons: ["cache:mcp-session-ready"],
        emptyState: false,
        cacheAttached: true,
      }),
    ),
    decideStartGate: vi.fn(
      (health: { level: string; emptyState: boolean }): MockStartGateDecision => {
        if (health.level === "high") {
          return { mayStart: false, reason: "browser-already-attached", level: "high" };
        }
        if (health.level === "medium") {
          return {
            mayStart: false,
            reason: "browser-auth-visual-verification-required",
            level: "medium",
          };
        }
        if (health.emptyState) {
          return { mayStart: true, reason: "browser-not-running" };
        }
        return { mayStart: false, reason: "browser-auth-conflict", level: "low" };
      },
    ),
    formatStartGateBlockedMessage: vi.fn(
      (name: string, _health: unknown, gate: { reason: string }) =>
        `Chrome MCP for profile "${name}": ${gate.reason}`,
    ),
  };
});

vi.mock("./chrome-mcp.js", () => chromeMcpMock);

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: vi.fn(async () => chromeMcpMock),
}));

const { createBrowserRouteContext } = await import("./server-context.js");
const chromeMcp = chromeMcpMock;

function makeState(): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      localLaunchTimeoutMs: 15_000,
      localCdpReadyTimeoutMs: 8_000,
      actionTimeoutMs: 60_000,
      color: "#FF4500",
      headless: false,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome-live",
      tabCleanup: {
        enabled: true,
        idleMinutes: 120,
        maxTabsPerSession: 8,
        sweepMinutes: 5,
      },
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
          userDataDir: "/tmp/brave-profile",
        },
      },
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    profiles: new Map(),
  };
}

function expectChromeLiveProfile() {
  return expect.objectContaining({
    name: "chrome-live",
    driver: "existing-session",
    userDataDir: "/tmp/brave-profile",
  });
}

beforeEach(() => {
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("browser server-context existing-session profile", () => {
  it("reports attach-only profiles as running when the MCP cache is healthy but no page is selected", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce(makeAttached(4321));
    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

    const profiles = await ctx.listProfiles();
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "chrome-live",
        transport: "chrome-mcp",
        running: true,
        tabCount: 0,
      }),
    ]);

    expect(chromeMcp.probeChromeMcpHealth).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
      {
        ephemeral: true,
      },
    );
  });

  it("reports chrome-mcp profiles as not-running when the session cache is empty without spawning", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce(makeUnattached("low", true));

    const profiles = await ctx.listProfiles();
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "chrome-live",
        transport: "chrome-mcp",
        running: false,
        tabCount: 0,
      }),
    ]);

    expect(chromeMcp.probeChromeMcpHealth).toHaveBeenCalledTimes(1);
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
    expect(chromeMcp.listChromeMcpTabs).not.toHaveBeenCalled();
  });

  it("reports running but skips ephemeral tab probe when chrome-mcp is live-attached but cache is cold", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce({
      level: "high",
      attached: true,
      mcpPid: null,
      port: 50211,
      browserUuid: "abc",
      reasons: ["file:devtools-active-port-detected", "owner:lsof-chrome-listener", "http:ok"],
      emptyState: false,
      cacheAttached: false,
    });

    const profiles = await ctx.listProfiles();
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "chrome-live",
        transport: "chrome-mcp",
        running: true,
        tabCount: 0,
      }),
    ]);

    expect(chromeMcp.probeChromeMcpHealth).toHaveBeenCalledTimes(1);
    expect(chromeMcp.listChromeMcpTabs).not.toHaveBeenCalled();
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
  });

  it("short-circuits ensureBrowserAvailable when probeChromeMcpHealth reports attached", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeAttached(4321));

    await live.ensureBrowserAvailable();

    expect(chromeMcp.probeChromeMcpHealth).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
    expect(chromeMcp.listChromeMcpTabs).not.toHaveBeenCalled();
  });

  it("does not short-circuit ensureBrowserAvailable when live-attached but cache is cold", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    // HIGH live signals but no cached MCP session: short-circuit must NOT
    // fire. The start-gate decides whether spawn is appropriate; HIGH is
    // refused so the user gets a clear error rather than fake success.
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue({
      level: "high",
      attached: true,
      mcpPid: null,
      port: 50211,
      browserUuid: "abc",
      reasons: ["file:devtools-active-port-detected", "owner:lsof-chrome-listener", "http:ok"],
      emptyState: false,
      cacheAttached: false,
    });

    await expect(live.ensureBrowserAvailable()).rejects.toThrow(/browser-already-attached/);
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
    expect(chromeMcp.decideStartGate).toHaveBeenCalledTimes(1);
  });

  it("attaches once and waits for ready when probeChromeMcpHealth reports unattached", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeUnattached("low", true));

    await live.ensureBrowserAvailable();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
  });

  it("coalesces concurrent ensureBrowserAvailable calls into one attach", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeUnattached("low", true));

    await Promise.all([live.ensureBrowserAvailable(), live.ensureBrowserAvailable()]);

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
  });

  it("routes tab operations through the Chrome MCP backend", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce(makeUnattached("low", true));
    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ]);

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["7", "8"]);

    const opened = await live.openTab("about:blank");
    expect(opened.targetId).toBe("8");

    const selected = await live.ensureTabAvailable();
    expect(selected.targetId).toBe("7");

    await live.focusTab("7");
    await live.stopRunningBrowser();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "about:blank",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "7",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledWith("chrome-live");
  });

  it("refuses to spawn chrome-mcp when the confidence probe reports MEDIUM", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce(
      makeUnattached("medium", false),
    );

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await expect(live.ensureBrowserAvailable()).rejects.toThrow(
      /browser-auth-visual-verification-required/,
    );
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
  });

  it("refuses to spawn chrome-mcp when LOW signals conflict (non-empty state)", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValueOnce(makeUnattached("low", false));

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await expect(live.ensureBrowserAvailable()).rejects.toThrow(/browser-auth-conflict/);
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
  });

  it("surfaces DevToolsActivePort attach failures instead of a generic tab timeout", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeUnattached("low", true));
    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValue(
      new Error(
        "Could not connect to Chrome. Check if Chrome is running. Cause: Could not find DevToolsActivePort for chrome at /tmp/brave-profile/DevToolsActivePort",
      ),
    );

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await expect(live.ensureBrowserAvailable()).rejects.toThrow(
      /could not connect to Chrome.*managed "openclaw" profile.*DevToolsActivePort/s,
    );
  });

  it("waits for two consecutive listChromeMcpTabs successes before resolving the start readiness", async () => {
    // chrome-devtools-mcp's first list_pages can land while it is still
    // finishing target sync, followed by a transient failure. The start
    // readiness must require two consecutive successes (separated by a
    // settle delay) before treating attach as live; otherwise the next
    // browser action races the still-syncing MCP child.
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeUnattached("low", true));
    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("transient sync race"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await live.ensureBrowserAvailable();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledTimes(4);
  });

  it("rejects start readiness when only a single listChromeMcpTabs success ever lands", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.probeChromeMcpHealth).mockResolvedValue(makeUnattached("low", true));
    let calls = 0;
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return [];
      }
      throw new Error("still syncing");
    });

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await expect(live.ensureBrowserAvailable()).rejects.toThrow(/still syncing/);
    expect(calls).toBeGreaterThan(1);
  });
});
