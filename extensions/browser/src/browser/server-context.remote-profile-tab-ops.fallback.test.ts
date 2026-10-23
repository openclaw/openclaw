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

function rawTab(id: string, url: string, type = "page", host = "wss://1.1.1.1:9222") {
  return { id, title: id, url, type, webSocketDebuggerUrl: `${host}/devtools/page/${id}` };
}
function withoutPlaywright() {
  vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
}
function jsonResponse(value: unknown) {
  return { ok: true, json: async () => value } as Response;
}
function rawList(tabs: ReturnType<typeof rawTab>[]) {
  withoutPlaywright();
  return deps.createRemoteRouteHarness(vi.fn(deps.createJsonListFetchMock(tabs)));
}
function rawCreate(created: ReturnType<typeof rawTab>) {
  withoutPlaywright();
  vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
    new Error("Target.createTarget unavailable"),
  );
  return deps.createRemoteRouteHarness(
    vi.fn(async (url: unknown) => {
      if (!String(url).includes("/json/new")) {
        throw new Error(`unexpected fetch: ${String(url)}`);
      }
      return jsonResponse(created);
    }),
  );
}
function attachOnlyState() {
  const state = deps.makeState("openclaw");
  state.resolved.attachOnly = false;
  state.resolved.profiles.openclaw = { cdpPort: 18800, attachOnly: true, color: "#FF4500" };
  return state;
}
function directWebSocketProfile(cdpUrl: string, ssrfPolicy = {}) {
  const state = deps.makeState("openclaw");
  state.resolved.ssrfPolicy = ssrfPolicy;
  state.resolved.profiles.openclaw = { cdpUrl, color: "#FF4500" };
  return deps.createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
}

describe("browser remote profile fallback and attachOnly behavior", () => {
  it.each<[string, boolean, RegExp]>([
    ["HTTP", false, /attachOnly is enabled/i],
    ["websocket", true, /attachOnly is enabled and CDP websocket/i],
  ])("rejects attachOnly %s failures without launching Chrome", async (_, httpReady, error) => {
    const state = attachOnlyState();
    const httpReachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(httpReady);
    const wsReachableMock = vi
      .mocked(deps.chromeModule.isChromeCdpReady)
      .mockResolvedValueOnce(false);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });
    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(error);
    expect(httpReachableMock).toHaveBeenCalled();
    if (httpReady) {
      expect(wsReachableMock).toHaveBeenCalled();
    }
    expect(deps.chromeModule.launchOpenClawChrome).not.toHaveBeenCalled();
  });

  it("filters browser-internal and non-page targets from raw CDP tab listing", async () => {
    const { remote } = rawList([
      rawTab("OMNI", "chrome://omnibox-popup.top-chrome/"),
      rawTab("UNTRUSTED", "chrome-untrusted://foo/"),
      rawTab("WORKER", "https://example.com/worker.js", "worker"),
      rawTab("T1", "https://example.com"),
    ]);

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(tabs[0]?.wsLookup).toBeTypeOf("function");
    expect(JSON.stringify(tabs[0])).not.toContain("wsLookup");
  });

  it("rejects policy-blocked discovered CDP websocket URLs from raw tab listings", async () => {
    const { state, remote } = rawList([
      rawTab("T_BLOCKED", "https://example.com", "page", "ws://169.254.169.254"),
    ]);
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.listTabs()).rejects.toBeInstanceOf(deps.BrowserCdpEndpointBlockedError);
  });

  it("rejects policy-blocked discovered CDP websocket URLs from raw tab creation", async () => {
    const { state, remote } = rawCreate(
      rawTab("T_BLOCKED", "about:blank", "page", "ws://169.254.169.254"),
    );
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.openTab("about:blank")).rejects.toBeInstanceOf(
      deps.BrowserCdpEndpointBlockedError,
    );
    expect(state.profiles.get("remote")?.lastTargetId).not.toBe("T_BLOCKED");
  });

  it("rejects non-page targets returned by raw tab creation", async () => {
    const created = rawTab("WORKER", "https://example.com/worker.js", "worker");
    const { state, remote } = rawCreate(created);

    await expect(remote.openTab("https://example.com")).rejects.toThrow(/non-selectable target/);
    expect(state.profiles.get("remote")?.lastTargetId).not.toBe(created.id);
  });

  it("fails closed for remote tab opens in strict mode without Playwright", async () => {
    withoutPlaywright();
    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.openTab("https://example.com")).rejects.toBeInstanceOf(
      deps.InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses remote-class tab-open timeouts for attachOnly loopback CDP profiles", async () => {
    withoutPlaywright();
    const createTargetViaCdp = vi
      .spyOn(deps.cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "T_ATTACH", finalUrl: "https://example.com" });
    const state = attachOnlyState();
    state.resolved.remoteCdpTimeoutMs = 2345;
    state.resolved.remoteCdpHandshakeTimeoutMs = 6789;
    const fetchMock = vi.fn(
      deps.createJsonListFetchMock([
        rawTab("T_ATTACH", "https://example.com", "page", "ws://127.0.0.1:18800"),
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
      timeouts: { httpTimeoutMs: 2345, handshakeTimeoutMs: 6789 },
    });
  });

  it("uses the remote HTTP timeout for /json/new fallback tab opens", async () => {
    withoutPlaywright();
    vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
      new Error("Target.createTarget unavailable"),
    );
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/json/new")) {
        const init = args[1] as RequestInit | undefined;
        expect(init).toMatchObject({ method: "PUT", signal: expect.any(AbortSignal) });
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
    expect(fetchInit).toMatchObject({
      method: "PUT",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(fetchInit.headers).toEqual({});
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
  expect(init).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  expect(init?.headers).toEqual({});
}

describe("browser server-context loopback direct WebSocket profiles", () => {
  it("uses an HTTPS /json base for secure direct WebSocket profiles with a /cdp suffix", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === "https://127.0.0.1:18800/json/list?token=abc") {
        return jsonResponse([rawTab("T2", "https://example.com", "page", "wss://127.0.0.1")]);
      }
      if (
        ["activate", "close"].some((op) => u === `https://127.0.0.1:18800/json/${op}/T2?token=abc`)
      ) {
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const openclaw = directWebSocketProfile("wss://127.0.0.1:18800/cdp?token=abc");

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
    const openclaw = directWebSocketProfile(
      "ws://10.0.0.42:18800/devtools/browser/SESSION?token=abc",
      { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["browserless.example.com"] },
    );

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
