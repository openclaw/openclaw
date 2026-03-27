import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

let chromeModule: typeof import("./chrome.js");
let InvalidBrowserNavigationUrlError: typeof import("./navigation-guard.js").InvalidBrowserNavigationUrlError;
let pwAiModule: typeof import("./pw-ai-module.js");
let closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;
let createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;
let createJsonListFetchMock: typeof import("./server-context.remote-tab-ops.harness.js").createJsonListFetchMock;
let createRemoteRouteHarness: typeof import("./server-context.remote-tab-ops.harness.js").createRemoteRouteHarness;
let createSequentialPageLister: typeof import("./server-context.remote-tab-ops.harness.js").createSequentialPageLister;
let makeState: typeof import("./server-context.remote-tab-ops.harness.js").makeState;

beforeAll(async () => {
  vi.resetModules();
  await import("./server-context.chrome-test-harness.js");
  chromeModule = await import("./chrome.js");
  ({ InvalidBrowserNavigationUrlError } = await import("./navigation-guard.js"));
  pwAiModule = await import("./pw-ai-module.js");
  ({ closePlaywrightBrowserConnection } = await import("./pw-session.js"));
  ({ createBrowserRouteContext } = await import("./server-context.js"));
  ({ createJsonListFetchMock, createRemoteRouteHarness, createSequentialPageLister, makeState } =
    await import("./server-context.remote-tab-ops.harness.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("browser server-context remote profile tab operations", () => {
  it("uses profile-level attachOnly when global attachOnly is false", async () => {
    const state = makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const reachableMock = vi.mocked(chromeModule.isChromeReachable).mockResolvedValueOnce(false);
    const launchMock = vi.mocked(chromeModule.launchOpenClawChrome);
    const ctx = createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled/i,
    );
    expect(reachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("keeps attachOnly websocket failures off the loopback ownership error path", async () => {
    const state = makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const httpReachableMock = vi.mocked(chromeModule.isChromeReachable).mockResolvedValueOnce(true);
    const wsReachableMock = vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValueOnce(false);
    const launchMock = vi.mocked(chromeModule.launchOpenClawChrome);
    const ctx = createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled and CDP websocket/i,
    );
    expect(httpReachableMock).toHaveBeenCalled();
    expect(wsReachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("uses Playwright tab operations when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T2",
      title: "Tab 2",
      url: "http://127.0.0.1:3000",
      type: "page",
    }));
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);

    const opened = await remote.openTab("http://127.0.0.1:3000");
    expect(opened.targetId).toBe("T2");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      url: "http://127.0.0.1:3000",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers lastTargetId for remote profiles when targetId is omitted", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
    ];

    const listPagesViaPlaywright = vi.fn(createSequentialPageLister(responses));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("skips Chrome internal UI targets for remote default selection", async () => {
    const listPagesViaPlaywright = vi.fn(
      createSequentialPageLister([
        [
          {
            targetId: "OMNI",
            title: "Omnibox",
            url: "chrome://omnibox-popup.top-chrome/",
            type: "page",
          },
        ],
        [
          {
            targetId: "OMNI",
            title: "Omnibox",
            url: "chrome://omnibox-popup.top-chrome/",
            type: "page",
          },
          {
            targetId: "REAL",
            title: "New Tab",
            url: "about:blank",
            type: "page",
          },
        ],
      ]),
    );
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "REAL",
      title: "New Tab",
      url: "about:blank",
      type: "page",
    }));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { state, remote } = createRemoteRouteHarness();

    const selected = await remote.ensureTabAvailable();
    expect(selected.targetId).toBe("REAL");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("REAL");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      url: "about:blank",
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("rejects stale targetId for remote profiles even when only one tab remains", async () => {
    const responses = [
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
    ];
    const listPagesViaPlaywright = vi.fn(createSequentialPageLister(responses));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("keeps rejecting stale targetId for remote profiles when multiple tabs exist", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
    ];
    const listPagesViaPlaywright = vi.fn(createSequentialPageLister(responses));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote } = createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = createRemoteRouteHarness();

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = createRemoteRouteHarness();

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to /json/list when Playwright is not available", async () => {
    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { remote } = createRemoteRouteHarness(
      vi.fn(
        createJsonListFetchMock([
          {
            id: "T1",
            title: "Tab 1",
            url: "https://example.com",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
            type: "page",
          },
        ]),
      ),
    );

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
  });

  it("fails closed for remote tab opens in strict mode without Playwright", async () => {
    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { state, remote, fetchMock } = createRemoteRouteHarness();
    state.resolved.ssrfPolicy = {};

    await expect(remote.openTab("https://example.com")).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not enforce managed tab cap for remote openclaw profiles", async () => {
    const listPagesViaPlaywright = vi
      .fn()
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
        { targetId: "T2", title: "2", url: "https://2.example", type: "page" },
        { targetId: "T3", title: "3", url: "https://3.example", type: "page" },
        { targetId: "T4", title: "4", url: "https://4.example", type: "page" },
        { targetId: "T5", title: "5", url: "https://5.example", type: "page" },
        { targetId: "T6", title: "6", url: "https://6.example", type: "page" },
        { targetId: "T7", title: "7", url: "https://7.example", type: "page" },
        { targetId: "T8", title: "8", url: "https://8.example", type: "page" },
        { targetId: "T9", title: "9", url: "https://9.example", type: "page" },
      ]);

    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://1.example",
      type: "page",
    }));

    vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);

    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { remote } = createRemoteRouteHarness(fetchMock);
    const opened = await remote.openTab("https://1.example");
    expect(opened.targetId).toBe("T1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
