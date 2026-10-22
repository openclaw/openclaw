import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../test-support.js";
import "../server-context.chrome-test-harness.js";
import "../../test-support/browser-security.mock.js";
import * as chromeModule from "../chrome.js";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createRouteFixture } from "./request.test-support.js";
import { registerBrowserTabRoutes } from "./tabs.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cdpUrl = "http://127.0.0.1:9222";
const wsUrl = "ws://127.0.0.1:9222/devtools/page/PAGE-1";

function setup(
  attachOnly: boolean,
  title: string,
  tabUrl: string,
  proxy = false,
  allowPrivateNetwork = false,
) {
  const state = makeBrowserServerState({
    profile: makeBrowserProfile({
      name: "manual-cdp",
      cdpUrl,
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPort: 9222,
      color: "#00AA00",
      attachOnly,
    }),
    resolvedOverrides: {
      defaultProfile: "manual-cdp",
      ...(proxy ? { extraArgs: ["--proxy-server=http://proxy.example.test:8080"] } : {}),
      ssrfPolicy: proxy ? { dangerouslyAllowPrivateNetwork: allowPrivateNetwork } : {},
    },
  });
  const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValue(true);
  const fetchMock = vi.fn(async (url: unknown) => {
    expect(String(url)).toBe(cdpUrl + "/json/list");
    return new Response(
      JSON.stringify([
        { id: "PAGE-1", title, url: tabUrl, webSocketDebuggerUrl: wsUrl, type: "page" },
      ]),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const routes = createRouteFixture();
  registerBrowserTabRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
  return {
    state,
    isChromeCdpReady,
    fetchMock,
    call: (action = false) =>
      routes.request(action ? "post" : "get", action ? "/tabs/action" : "/tabs", {
        query: { profile: "manual-cdp" },
        body: action ? { action: "list" } : {},
      }),
  };
}

describe("browser tab routes attachOnly loopback profiles", () => {
  it("lists tabs for manual loopback CDP profiles under strict SSRF", async () => {
    const { state, isChromeCdpReady, call } = setup(
      true,
      "WordPress",
      "https://example.com/wp-login.php",
    );
    const response = await call();
    expect(isChromeCdpReady).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
      { signal: expect.any(AbortSignal), onDiagnostic: expect.any(Function) },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      canAutoResizeViewport: false,
      tabs: [
        {
          targetId: "PAGE-1",
          suggestedTargetId: "t1",
          tabId: "t1",
          title: "WordPress",
          url: "https://example.com/wp-login.php",
          wsUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
          type: "page",
        },
      ],
    });
  });

  it.each([
    [false, false, ""],
    [false, true, "http://93.184.216.34/proxy-routed"],
    [true, false, "http://93.184.216.34/proxy-routed"],
  ] as const)(
    "applies proxy policy (attachOnly=%s, allowPrivateNetwork=%s)",
    async (attachOnly, allowPrivateNetwork, expectedUrl) => {
      const { fetchMock, call } = setup(
        attachOnly,
        "Proxy routed",
        "http://93.184.216.34/proxy-routed",
        true,
        allowPrivateNetwork,
      );
      const getResponse = await call();
      const actionResponse = await call(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const response of [getResponse, actionResponse]) {
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
          tabs: [{ targetId: "PAGE-1", title: "Proxy routed", url: expectedUrl }],
        });
      }
    },
  );
});
