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
const loginUrl = "https://example.com/wp-login.php";
const proxyUrl = "http://93.184.216.34/proxy-routed";
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
      cdpPort: 9222,
      attachOnly,
    }),
    resolvedOverrides: {
      ...(proxy ? { extraArgs: ["--proxy-server=http://proxy.example.test:8080"] } : {}),
      ssrfPolicy: proxy ? { dangerouslyAllowPrivateNetwork: allowPrivateNetwork } : {},
    },
  });
  vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValue(true);
  const fetchMock = vi.fn(async (url: unknown) => {
    expect(String(url)).toBe(cdpUrl + "/json/list");
    return Response.json([
      { id: "PAGE-1", title, url: tabUrl, webSocketDebuggerUrl: wsUrl, type: "page" },
    ]);
  });
  vi.stubGlobal("fetch", fetchMock);
  const routes = createRouteFixture();
  registerBrowserTabRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
  return {
    call: (action = false) =>
      routes.request(action ? "post" : "get", action ? "/tabs/action" : "/tabs", {
        query: { profile: "manual-cdp" },
        body: action ? { action: "list" } : {},
      }),
  };
}

describe("browser tab routes attachOnly loopback profiles", () => {
  it("lists tabs for manual loopback CDP profiles under strict SSRF", async () => {
    const { call } = setup(true, "WordPress", loginUrl);
    const response = await call();
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      canAutoResizeViewport: false,
      tabs: [
        {
          targetId: "PAGE-1",
          title: "WordPress",
          url: loginUrl,
          wsUrl,
          type: "page",
          suggestedTargetId: "t1",
          tabId: "t1",
        },
      ],
    });
  });

  it.each([
    [false, false, ""],
    [false, true, proxyUrl],
    [true, false, proxyUrl],
  ] as const)(
    "applies proxy policy (attachOnly=%s, allowPrivateNetwork=%s)",
    async (attachOnly, allowPrivateNetwork, expectedUrl) => {
      const { call } = setup(attachOnly, "Proxy routed", proxyUrl, true, allowPrivateNetwork);
      const getResponse = await call();
      const actionResponse = await call(true);
      for (const response of [getResponse, actionResponse]) {
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
          tabs: [{ targetId: "PAGE-1", title: "Proxy routed", url: expectedUrl }],
        });
      }
    },
  );
});
