import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionStub,
  pagesResult,
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
  textResult,
  type ToolCall,
} from "./chrome-mcp.test-support.js";

const { fetchJsonMock, fetchOkMock } = vi.hoisted(() => ({
  fetchJsonMock: vi.fn(),
  fetchOkMock: vi.fn(),
}));

vi.mock("./chrome-mcp-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chrome-mcp-connect.js")>();
  return { ...actual, createChromeMcpSession: vi.fn(actual.createChromeMcpSession) };
});

vi.mock("./cdp.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdp.helpers.js")>();
  return {
    ...actual,
    fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
    fetchOk: (...args: unknown[]) => fetchOkMock(...args),
    resolveCdpTabOwnership: async (params: Parameters<typeof actual.resolveCdpTabOwnership>[0]) => {
      const version = (await fetchJsonMock(
        `${actual.normalizeCdpHttpBaseForJsonEndpoints(params.cdpUrl)}/json/version`,
        params.timeoutMs,
        { signal: params.signal },
        params.ssrfPolicy,
      )) as { webSocketDebuggerUrl?: unknown };
      if (
        typeof version.webSocketDebuggerUrl !== "string" ||
        !/\/devtools\/browser\/[^/?#]+/i.test(new URL(version.webSocketDebuggerUrl).pathname)
      ) {
        return { status: "non-durable", reason: "browser-identity-unavailable" };
      }
      return {
        status: "durable",
        nativeTargetId: params.nativeTargetId,
        profileFingerprint: "sha256:fixture-profile",
        browserInstanceFingerprint: "sha256:fixture-browser",
      };
    },
  };
});

import { openChromeMcpTab } from "./chrome-mcp.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

type FakePage = {
  id: number;
  nativeTargetId: string;
  url: string;
};

const existingPage = { id: 1, nativeTargetId: "NATIVE-EXISTING", url: "about:blank" };
const cdpProfile = { cdpUrl: "http://127.0.0.1:9222" };

function createMarkerSession(options: { existingPage?: boolean; navigateError?: Error } = {}) {
  const pages: FakePage[] = options.existingPage === false ? [] : [{ ...existingPage }];
  const events: string[] = [];
  const readUrl = (value: unknown) => (typeof value === "string" ? value : "");
  const callTool = vi.fn(async (call: ToolCall) => {
    if (call.name === "new_page") {
      const url = readUrl(call.arguments?.url);
      const page = {
        id: pages.length + 1,
        nativeTargetId: `NATIVE-${pages.length + 1}`,
        url,
      };
      pages.push(page);
      events.push(`new:${url}`);
      return pagesResult([{ id: page.id, url: page.url, selected: true }]);
    }
    if (call.name === "navigate_page") {
      if (options.navigateError) {
        throw options.navigateError;
      }
      const page = pages.find((candidate) => candidate.id === call.arguments?.pageId);
      if (!page) {
        throw new Error("unknown page");
      }
      events.push(`navigate:${page.url}`);
      page.url = readUrl(call.arguments?.url);
      return textResult("navigated");
    }
    if (call.name === "list_pages") {
      return pagesResult(pages.map((page) => ({ id: page.id, url: page.url })));
    }
    if (call.name === "close_page") {
      const pageIndex = pages.findIndex((candidate) => candidate.id === call.arguments?.pageId);
      if (pageIndex < 0) {
        throw new Error("unknown page");
      }
      const [closed] = pages.splice(pageIndex, 1);
      events.push(`close:${closed?.url ?? ""}`);
      return textResult("closed");
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  const session = createSessionStub(callTool, 123);
  setChromeMcpSessionFactoryForTest(() => session);
  return { callTool, pages, events };
}

function mockMarkerLookup(
  pages: FakePage[],
  webSocketDebuggerUrl = "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
) {
  fetchJsonMock.mockImplementation(async (url: string) =>
    url.includes("/json/list")
      ? pages.map((page) => ({ id: page.nativeTargetId, url: page.url, type: "page" }))
      : { webSocketDebuggerUrl },
  );
}

function mockNativeClose(pages: FakePage[]) {
  fetchOkMock.mockImplementationOnce(async (url: string) => {
    const nativeTargetId = decodeURIComponent(url.split("/").at(-1) ?? "");
    const index = pages.findIndex((page) => page.nativeTargetId === nativeTargetId);
    if (index >= 0) {
      pages.splice(index, 1);
    }
  });
}

describe("Chrome MCP durable tab ownership", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    fetchJsonMock.mockReset();
    fetchOkMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.restoreAllMocks();
  });

  it("serializes duplicate-destination opens while preserving unique marker mapping", async () => {
    const { callTool, pages } = createMarkerSession();
    mockMarkerLookup(pages);

    const [first, second] = await Promise.all([
      openChromeMcpTab("chrome-live", "https://example.com/same", cdpProfile),
      openChromeMcpTab("chrome-live", "https://example.com/same", cdpProfile),
    ]);

    expect(first.ownership).toMatchObject({ nativeTargetId: "NATIVE-2" });
    expect(second.ownership).toMatchObject({ nativeTargetId: "NATIVE-3" });
    const calls = callTool.mock.calls;
    const markerUrls = calls
      .filter(([call]) => call.name === "new_page")
      .map(([call]) => call.arguments?.url);
    expect(new Set(markerUrls).size).toBe(2);
  });

  it("threads CDP policy, signal, and remote HTTP timeout through marker capture", async () => {
    const { pages } = createMarkerSession();
    mockMarkerLookup(pages, "wss://browser.example/devtools/browser/BROWSER-ONE");
    const controller = new AbortController();
    const cdpPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["browser.example"],
    };
    const operationOptions = {
      signal: controller.signal,
      cdpPolicy,
      cdpTimeouts: { httpTimeoutMs: 4321, handshakeTimeoutMs: 8765 },
    };

    await openChromeMcpTab(
      "chrome-live",
      "https://example.com",
      { cdpUrl: "https://browser.example" },
      operationOptions,
    );

    const ownershipFetches = fetchJsonMock.mock.calls.filter(([url]) =>
      /\/json\/(?:list|version)/.test(String(url)),
    );
    expect(ownershipFetches).toEqual([
      ["https://browser.example/json/list", 4321, { signal: controller.signal }, cdpPolicy],
      ["https://browser.example/json/version", 4321, { signal: controller.signal }, cdpPolicy],
    ]);
  });

  it("propagates aborts and strict CDP policy failures from marker lookup", async () => {
    const abortedSession = createMarkerSession();
    const controller = new AbortController();
    const abortError = new Error("marker lookup aborted");
    fetchJsonMock.mockImplementationOnce(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(
      openChromeMcpTab("chrome-live", "about:blank", cdpProfile, { signal: controller.signal }),
    ).rejects.toThrow("marker lookup aborted");
    expect(abortedSession.pages).toEqual([existingPage]);
    expect(abortedSession.events.at(-1)).toMatch(/^close:about:blank#openclaw-/);

    await resetChromeMcpSessionsForTest();
    const blockedSession = createMarkerSession();
    const blocked = new BrowserCdpEndpointBlockedError({
      cause: new Error("strict SSRF policy rejected endpoint"),
    });
    fetchJsonMock.mockRejectedValueOnce(blocked);

    await expect(
      openChromeMcpTab("chrome-live", "about:blank", {
        cdpUrl: "http://10.0.0.1:9222",
      }),
    ).rejects.toBe(blocked);
    expect(blockedSession.pages).toEqual([existingPage]);
  });

  it("rejects an empty auto-connected browser before creating a page", async () => {
    const { callTool, pages } = createMarkerSession({ existingPage: false });

    await expect(openChromeMcpTab("chrome-live", "about:blank")).rejects.toThrow(
      "without an explicit CDP endpoint",
    );
    expect(pages).toEqual([]);
    const calls = callTool.mock.calls;
    expect(calls.map(([call]) => call.name)).toEqual(["list_pages"]);
  });

  it("rejects and closes a first page without durable browser ownership", async () => {
    const { pages } = createMarkerSession({ existingPage: false });
    mockMarkerLookup(pages, "ws://127.0.0.1:9222/devtools/page/NATIVE-1");
    mockNativeClose(pages);

    await expect(openChromeMcpTab("chrome-live", "about:blank", cdpProfile)).rejects.toThrow(
      "without durable CDP ownership",
    );
    expect(pages).toEqual([]);
    expect(fetchOkMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/close/NATIVE-1",
      undefined,
      undefined,
      undefined,
    );
  });

  it.each([
    ["HTTP", "--browserUrl", "http://127.0.0.1:9222"],
    ["WebSocket", "--wsEndpoint", "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE"],
  ])(
    "closes a failed first-page marker through its captured native target using %s mcpArgs override",
    async (_label, flag, endpoint) => {
      const navigateError = new Error("navigation failed");
      const { callTool, pages } = createMarkerSession({ existingPage: false, navigateError });
      mockMarkerLookup(pages);
      mockNativeClose(pages);

      const profile = { cdpUrl: "http://127.0.0.1:9333", mcpArgs: [flag, endpoint] };
      await expect(openChromeMcpTab("chrome-live", "https://example.com", profile)).rejects.toBe(
        navigateError,
      );
      expect(pages).toEqual([]);
      expect(fetchJsonMock.mock.calls.map(([url]) => url)).toEqual([
        "http://127.0.0.1:9222/json/list",
        "http://127.0.0.1:9222/json/version",
      ]);
      expect(fetchOkMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9222/json/close/NATIVE-1",
        undefined,
        undefined,
        undefined,
      );
      const calls = callTool.mock.calls;
      expect(calls.map(([call]) => call.name)).not.toContain("close_page");
    },
  );

  it("classifies malformed marker list entries as lookup failures", async () => {
    createMarkerSession();
    fetchJsonMock.mockResolvedValueOnce([null, undefined, "not-a-target"]);

    const opened = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "https://browser.example",
    });

    expect(opened.ownership).toEqual({
      status: "non-durable",
      reason: "target-marker-lookup-failed",
    });
  });

  it("returns non-durable ownership for ambiguous marker matches", async () => {
    const matches = ["NATIVE-A", "NATIVE-B"];
    const { pages } = createMarkerSession();
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return matches.map((id) => ({ id, type: "page", url: pages.at(-1)?.url }));
      }
      return {
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
      };
    });

    const opened = await openChromeMcpTab("chrome-live", "https://example.com/final", cdpProfile);

    expect(opened.ownership).toEqual({
      status: "non-durable",
      reason: "target-marker-not-unique",
    });
  });
});
