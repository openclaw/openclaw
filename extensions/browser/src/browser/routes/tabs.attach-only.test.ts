// Browser tests cover tabs.attach only plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../test-support.js";
import "../server-context.chrome-test-harness.js";
import "../../test-support/browser-security.mock.js";
import * as chromeModule from "../chrome.js";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMock = vi.hoisted(() => ({
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    {
      targetId: "MCP-PAGE-1",
      title: "",
      url: "https://example.com/mcp",
      type: "page",
    },
  ]),
}));

vi.mock("../chrome-mcp.js", () => chromeMcpMock);

vi.mock("../chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: vi.fn(async () => chromeMcpMock),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser tab routes attachOnly loopback profiles", () => {
  it("lists tabs for manual loopback CDP profiles under strict SSRF", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });

    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    isChromeCdpReady.mockResolvedValue(true);

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("http://127.0.0.1:9222/json/list");
      return {
        ok: true,
        json: async () => [
          {
            id: "PAGE-1",
            title: "WordPress",
            url: "https://example.com/wp-login.php",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/PAGE-1",
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, ctx as never);
    const handler = getHandlers.get("/tabs");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "manual-cdp" }, body: {} }, response.res);

    expect(isChromeCdpReady).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
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

  it("uses the full Chrome MCP attach path before listing existing-session tabs", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "chrome-live",
        cdpUrl: "http://127.0.0.1:9223",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 0,
        color: "#0066CC",
        driver: "existing-session",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "chrome-live",
        ssrfPolicy: {},
      },
    });

    const ctx = createBrowserRouteContext({ getState: () => state });
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, ctx as never);
    const handler = getHandlers.get("/tabs");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "chrome-live" }, body: {} }, response.res);

    expect(chromeMcpMock.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expect.objectContaining({ driver: "existing-session", name: "chrome-live" }),
    );
    expect(chromeMcpMock.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expect.objectContaining({ driver: "existing-session", name: "chrome-live" }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      running: true,
      tabs: [
        {
          targetId: "MCP-PAGE-1",
          suggestedTargetId: "t1",
          tabId: "t1",
          title: "",
          url: "https://example.com/mcp",
          type: "page",
        },
      ],
    });
  });
});
