import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserServerState } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const braveProfileDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-brave-profile-")),
);

afterAll(() => {
  fs.rmSync(braveProfileDir, { recursive: true, force: true });
});

const chromeMcpMock = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => true),
  countChromeMcpTabs: vi.fn(
    async (
      _profileName: string,
      _profile: unknown,
      _options?: { ephemeral?: boolean; signal?: AbortSignal },
    ) => 1,
  ),
  ensureChromeMcpAvailable: vi.fn(
    async (
      profileName: string,
      profile: unknown,
      options?: {
        signal?: AbortSignal;
        pageProbe?: { onResult: (tabCount: number | null) => void };
      },
    ) => {
      if (!options?.pageProbe) {
        return;
      }
      try {
        options.pageProbe.onResult(
          await chromeMcpMock.countChromeMcpTabs(profileName, profile, {
            ephemeral: true,
            signal: options.signal,
          }),
        );
      } catch {
        options.pageProbe.onResult(null);
      }
    },
  ),
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
}));

vi.mock("./chrome-mcp.js", () => chromeMcpMock);

const { createBrowserRouteContext } = await import("./server-context.js");
const chromeMcp = chromeMcpMock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tab(targetId: string, url: string, title = "") {
  return { targetId, title, url, type: "page" as const };
}

function makeState(): BrowserServerState {
  return makeBrowserServerState({
    profile: makeBrowserProfile({
      name: "chrome-live",
      cdpPort: 18801,
      color: "#0066CC",
      driver: "existing-session",
      attachOnly: true,
      userDataDir: braveProfileDir,
    }),
    resolvedOverrides: {
      evaluateEnabled: true,
      headless: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
          userDataDir: braveProfileDir,
        },
      },
    },
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
  vi.mocked(chromeMcp.listChromeMcpTabs)
    .mockReset()
    .mockResolvedValue([{ targetId: "7", title: "", url: "https://example.com", type: "page" }]);
  vi.mocked(chromeMcp.countChromeMcpTabs).mockReset().mockResolvedValue(1);
  vi.mocked(chromeMcp.openChromeMcpTab).mockReset().mockResolvedValue({
    targetId: "8",
    title: "",
    url: "about:blank",
    type: "page",
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("browser server-context existing-session profile", () => {
  it("fails closed for Chrome MCP endpoint mcpArgs under the default CDP policy", async () => {
    const state = makeState();
    state.resolved.ssrfPolicy = {};
    state.resolved.profiles["chrome-live"] = {
      ...state.resolved.profiles["chrome-live"],
      mcpArgs: ["--browserUrl", "http://127.0.0.1:9222"],
    };
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await expect(live.listTabs()).rejects.toThrow(/Chrome MCP cannot carry that pinned transport/);
    await expect(live.openTab("https://example.com")).rejects.toThrow(
      /remove cdpUrl and browserUrl\/wsEndpoint mcpArgs/,
    );
    await expect(live.ensureBrowserAvailable()).rejects.toThrow(/host-local Chrome profile/);

    expect(chromeMcp.listChromeMcpTabs).not.toHaveBeenCalled();
    expect(chromeMcp.openChromeMcpTab).not.toHaveBeenCalled();
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
  });

  it("reports endpoint cdpUrl for existing-session profiles", async () => {
    const state = makeState();
    const chromeLiveProfile = expectDefined(
      state.resolved.profiles["chrome-live"],
      "chrome-live browser profile",
    );
    state.resolved.ssrfPolicy = undefined;
    state.resolved.profiles["chrome-live"] = {
      ...chromeLiveProfile,
      cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });

    const profiles = await ctx.listProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.transport).toBe("chrome-mcp");
    expect(profiles[0]?.cdpPort).toBeNull();
    expect(profiles[0]?.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expect.objectContaining({ cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222" }),
      expect.anything(),
    );
  });

  it("eagerly closes MCP while attach readiness is pending and prevents retry", async () => {
    const readinessEntered = deferred<void>();
    const readiness = deferred<never>();
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementationOnce(async () => {
      readinessEntered.resolve();
      return await readiness.promise;
    });
    let mcpSessionCached = true;
    const closeResults: boolean[] = [];
    vi.mocked(chromeMcp.closeChromeMcpSession)
      .mockReset()
      .mockImplementation(async () => {
        const closed = mcpSessionCached;
        mcpSessionCached = false;
        closeResults.push(closed);
        return closed;
      });
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    const starting = live.ensureBrowserAvailable();
    await readinessEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    readiness.reject(new Error("attach not ready"));

    await expect(starting).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledTimes(1);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(2);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(1, "chrome-live");
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(2, "chrome-live");
    expect(closeResults).toEqual([true, false]);
    expect(mcpSessionCached).toBe(false);
  });

  it("drains an admitted MCP tab open before the final session sweep", async () => {
    const openEntered = deferred<void>();
    const opened = deferred<{
      targetId: string;
      title: string;
      url: string;
      type: "page";
    }>();
    vi.mocked(chromeMcp.openChromeMcpTab).mockImplementationOnce(async () => {
      openEntered.resolve();
      return await opened.promise;
    });
    let mcpSessionCached = true;
    const closeResults: boolean[] = [];
    vi.mocked(chromeMcp.closeChromeMcpSession)
      .mockReset()
      .mockImplementation(async () => {
        const closed = mcpSessionCached;
        mcpSessionCached = false;
        closeResults.push(closed);
        return closed;
      });
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await live.ensureTabAvailable();
    const aliasesBefore = structuredClone(state.profiles.get("chrome-live")?.tabAliases);
    const opening = live.openTab("about:blank");
    await openEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    opened.resolve({ targetId: "late", title: "", url: "about:blank", type: "page" });

    await expect(opening).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledTimes(1);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(2);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(1, "chrome-live");
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(2, "chrome-live");
    expect(closeResults).toEqual([true, false]);
    expect(mcpSessionCached).toBe(false);
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe("7");
    expect(state.profiles.get("chrome-live")?.tabAliases).toEqual(aliasesBefore);
  });

  it("expires Chrome MCP aliases instead of transferring them to a replacement tab", async () => {
    const originalTab = tab("TARGET-A", "https://shop.example/checkout", "Checkout");
    const replacementTab = { ...originalTab, targetId: "TARGET-B" };
    let currentTabs = [originalTab];
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "TARGET-A", tabId: "t1" }),
    ]);
    await live.labelTab("t1", "checkout");
    await expect(live.ensureTabAvailable()).resolves.toMatchObject({ targetId: "TARGET-A" });

    currentTabs = [replacementTab];
    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "TARGET-B",
        tabId: "t2",
        suggestedTargetId: "t2",
      }),
    ]);
    await expect(live.ensureTabAvailable()).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("t1")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("checkout")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("TARGET-B")).resolves.toEqual(
      expect.objectContaining({ targetId: "TARGET-B", tabId: "t2" }),
    );
  });

  it("does not sticky-adopt a Chrome MCP tab when the final URL is policy-blocked", async () => {
    const goodTab = tab("chrome-mcp:good:1", "https://example.com/", "Good");
    const blockedTargetId = "chrome-mcp:blocked:1";
    vi.mocked(chromeMcp.openChromeMcpTab).mockResolvedValueOnce(goodTab).mockResolvedValueOnce({
      targetId: blockedTargetId,
      title: "Blocked",
      url: "http://127.0.0.1:9/",
      type: "page",
    });
    vi.mocked(chromeMcp.listChromeMcpTabs).mockResolvedValue([
      goodTab,
      {
        targetId: blockedTargetId,
        title: "Blocked",
        url: "http://127.0.0.1:9/",
        type: "page",
      },
    ]);
    const state = makeState();
    state.resolved.ssrfPolicy = {};
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await expect(live.openTab("https://example.com", { label: "good" })).resolves.toEqual(
      expect.objectContaining({ targetId: goodTab.targetId }),
    );
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe(goodTab.targetId);

    await expect(
      live.openTab("https://example.com/redirect", { label: "blocked" }),
    ).rejects.toThrow(/private|blocked|ssrf/i);
    const profileState = state.profiles.get("chrome-live");
    expect(profileState?.lastTargetId).toBe(goodTab.targetId);
    expect(profileState?.lastTargetId).not.toBe(blockedTargetId);
    expect(profileState?.tabAliases).toEqual({
      nextTabNumber: 2,
      byTargetId: {
        [goodTab.targetId]: {
          tabId: "t1",
          label: "good",
          url: goodTab.url,
        },
      },
    });

    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: goodTab.targetId }),
    );
  });

  it("clears only the sticky Chrome MCP target after a successful close", async () => {
    const tabA = tab("chrome-mcp:fresh:1", "https://a.example", "A");
    const tabB = tab("chrome-mcp:fresh:2", "https://b.example", "B");
    let currentTabs = [tabA, tabB];
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await live.focusTab(tabA.targetId);
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      tabA.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    vi.mocked(chromeMcp.closeChromeMcpTab).mockRejectedValueOnce(new Error("close failed"));
    await expect(live.closeTab(tabA.targetId)).rejects.toThrow("close failed");
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe(tabA.targetId);
    await expect(live.ensureTabAvailable()).resolves.toMatchObject({ targetId: tabA.targetId });
    await live.closeTab(tabA.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      2,
      "chrome-live",
      tabA.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabB];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabB.targetId }),
    );

    currentTabs = [tabA, tabB];
    await live.ensureTabAvailable(tabA.targetId);
    await live.closeTab(tabB.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      3,
      "chrome-live",
      tabB.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabA];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabA.targetId }),
    );
  });

  it("surfaces DevToolsActivePort attach failures instead of a generic tab timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValue(
      new Error(
        `Could not connect to Chrome. Check if Chrome is running. Cause: Could not find DevToolsActivePort for chrome at ${braveProfileDir}/DevToolsActivePort`,
      ),
    );

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    const pending = live.ensureBrowserAvailable();
    const assertion = expect(pending).rejects.toThrow(
      /could not connect to Chrome.*managed "openclaw" profile.*DevToolsActivePort/s,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });
});
