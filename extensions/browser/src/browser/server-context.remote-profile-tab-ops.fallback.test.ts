import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
  type RemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

function rawTab(id: string, url: string, type = "page") {
  return {
    id,
    title: id,
    url,
    type,
    webSocketDebuggerUrl: `wss://1.1.1.1:9222/devtools/page/${id}`,
  };
}

describe("browser remote profile fallback and attachOnly behavior", () => {
  it("uses profile-level attachOnly when global attachOnly is false", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const reachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled/i,
    );
    expect(reachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("keeps attachOnly websocket failures off the loopback ownership error path", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const httpReachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(true);
    const wsReachableMock = vi
      .mocked(deps.chromeModule.isChromeCdpReady)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled and CDP websocket/i,
    );
    expect(httpReachableMock).toHaveBeenCalled();
    expect(wsReachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("filters browser-internal and non-page targets from raw CDP tab listing", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { remote } = deps.createRemoteRouteHarness(
      vi.fn(
        deps.createJsonListFetchMock([
          rawTab("OMNI", "chrome://omnibox-popup.top-chrome/"),
          rawTab("UNTRUSTED", "chrome-untrusted://foo/"),
          rawTab("WORKER", "https://example.com/worker.js", "worker"),
          rawTab("T1", "https://example.com"),
        ]),
      ),
    );

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(tabs[0]?.wsLookup).toBeTypeOf("function");
    expect(JSON.stringify(tabs[0])).not.toContain("wsLookup");
  });

  it("rejects policy-blocked discovered CDP websocket URLs from raw tab listings", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { state, remote } = deps.createRemoteRouteHarness(
      vi.fn(
        deps.createJsonListFetchMock([
          {
            id: "T_BLOCKED",
            title: "Blocked",
            url: "https://example.com",
            webSocketDebuggerUrl: "ws://169.254.169.254/devtools/page/T_BLOCKED",
            type: "page",
          },
        ]),
      ),
    );
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.listTabs()).rejects.toBeInstanceOf(deps.BrowserCdpEndpointBlockedError);
  });

  it("rejects policy-blocked discovered CDP websocket URLs from raw tab creation", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
      new Error("Target.createTarget unavailable"),
    );
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/new")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => ({
          id: "T_BLOCKED",
          title: "Blocked",
          url: "about:blank",
          webSocketDebuggerUrl: "ws://169.254.169.254/devtools/page/T_BLOCKED",
          type: "page",
        }),
      } as unknown as Response;
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.openTab("about:blank")).rejects.toBeInstanceOf(
      deps.BrowserCdpEndpointBlockedError,
    );
    expect(state.profiles.get("remote")?.lastTargetId).not.toBe("T_BLOCKED");
  });

  it("rejects non-page targets returned by raw tab creation", async () => {
    const created = rawTab("WORKER", "https://example.com/worker.js", "worker");
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
      new Error("Target.createTarget unavailable"),
    );
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/new")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => ({
          ...created,
          webSocketDebuggerUrl: `wss://1.1.1.1:9222/devtools/page/${created.id}`,
        }),
      } as unknown as Response;
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);

    await expect(remote.openTab("https://example.com")).rejects.toThrow(/non-selectable target/);
    expect(state.profiles.get("remote")?.lastTargetId).not.toBe(created.id);
  });

  it("fails closed for remote tab opens in strict mode without Playwright", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.openTab("https://example.com")).rejects.toBeInstanceOf(
      deps.InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses remote-class tab-open timeouts for attachOnly loopback CDP profiles", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const createTargetViaCdp = vi
      .spyOn(deps.cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "T_ATTACH", finalUrl: "https://example.com" });
    const state = deps.makeState("openclaw");
    state.resolved.remoteCdpTimeoutMs = 2345;
    state.resolved.remoteCdpHandshakeTimeoutMs = 6789;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };
    const fetchMock = vi.fn(
      deps.createJsonListFetchMock([
        {
          id: "T_ATTACH",
          title: "Attach Tab",
          url: "https://example.com",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/T_ATTACH",
          type: "page",
        },
      ]),
    );
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    const opened = await ctx.forProfile("openclaw").openTab("https://example.com");

    expect(opened.targetId).toBe("T_ATTACH");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "https://example.com",
      ssrfPolicy: undefined,
      signal: expect.any(AbortSignal),
      waitForNavigationResult: true,
      timeouts: {
        httpTimeoutMs: 2345,
        handshakeTimeoutMs: 6789,
      },
    });
  });

  it("uses the remote HTTP timeout for /json/new fallback tab opens", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
      new Error("Target.createTarget unavailable"),
    );
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/json/new")) {
        const init = args[1] as RequestInit | undefined;
        expect(init?.method).toBe("PUT");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted after remote timeout")),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);
    state.resolved.remoteCdpTimeoutMs = 25;

    const startedAt = Date.now();
    await expect(remote.openTab("https://example.com")).rejects.toThrow(
      /aborted after remote timeout/,
    );

    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = expectDefined(
      (fetchMock.mock.calls as Array<[string | URL, RequestInit & { dispatcher?: unknown }]>)[0],
      "remote profile fetch call",
    );
    const [fetchUrl, fetchInit] = call;
    expect(String(fetchUrl)).toBe(
      "https://1.1.1.1:9222/chrome/json/new?token=abc&url=https%3A%2F%2Fexample.com",
    );
    expect(fetchInit.method).toBe("PUT");
    expect(fetchInit.headers).toEqual({});
    expect(fetchInit.redirect).toBe("manual");
    expect(fetchInit.signal).toBeInstanceOf(AbortSignal);
    expect(fetchInit.dispatcher).toBeUndefined();
  });
});

function expectFetchCalledWithManualRedirect(
  fetchMock: ReturnType<typeof vi.fn>,
  expectedUrl: string,
) {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === expectedUrl);
  if (!call) {
    throw new Error(`Expected fetch call for ${expectedUrl}`);
  }
  const init = call[1] as RequestInit | undefined;
  expect(init?.redirect).toBe("manual");
  expect(init?.headers).toEqual({});
  expect(init?.signal).toBeInstanceOf(AbortSignal);
}

describe("browser server-context loopback direct WebSocket profiles", () => {
  it("uses an HTTPS /json base for secure direct WebSocket profiles with a /cdp suffix", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === "https://127.0.0.1:18800/json/list?token=abc") {
        return {
          ok: true,
          json: async () => [
            {
              id: "T2",
              title: "Secure Tab",
              url: "https://example.com",
              webSocketDebuggerUrl: "wss://127.0.0.1/devtools/page/T2",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      if (u === "https://127.0.0.1:18800/json/activate/T2?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      if (u === "https://127.0.0.1:18800/json/close/T2?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = deps.makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    state.resolved.profiles.openclaw = {
      cdpUrl: "wss://127.0.0.1:18800/cdp?token=abc",
      color: "#FF4500",
    };
    const ctx = deps.createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const tabs = await openclaw.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["T2"]);

    await openclaw.focusTab("T2");
    await openclaw.closeTab("T2");
    expectFetchCalledWithManualRedirect(
      fetchMock,
      "https://127.0.0.1:18800/json/activate/T2?token=abc",
    );
    expectFetchCalledWithManualRedirect(
      fetchMock,
      "https://127.0.0.1:18800/json/close/T2?token=abc",
    );
  });

  it("blocks direct WebSocket tab operations when strict SSRF hostname allowlist rejects the cdpUrl", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = deps.makeState("openclaw");
    state.resolved.ssrfPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["browserless.example.com"],
    };
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://10.0.0.42:18800/devtools/browser/SESSION?token=abc",
      color: "#FF4500",
    };
    const ctx = deps.createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.listTabs()).rejects.toBeInstanceOf(deps.BrowserCdpEndpointBlockedError);
    await expect(openclaw.focusTab("T1")).rejects.toBeInstanceOf(
      deps.BrowserCdpEndpointBlockedError,
    );
    await expect(openclaw.closeTab("T1")).rejects.toBeInstanceOf(
      deps.BrowserCdpEndpointBlockedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
