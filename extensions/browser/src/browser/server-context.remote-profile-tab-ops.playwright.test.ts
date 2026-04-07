import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RemoteProfileTestDeps = {
  chromeModule: typeof import("./chrome.js");
  InvalidBrowserNavigationUrlError: typeof import("./navigation-guard.js").InvalidBrowserNavigationUrlError;
  pwAiModule: typeof import("./pw-ai-module.js");
  closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;
  createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;
  createJsonListFetchMock: typeof import("./server-context.remote-tab-ops.harness.js").createJsonListFetchMock;
  createRemoteRouteHarness: typeof import("./server-context.remote-tab-ops.harness.js").createRemoteRouteHarness;
  createSequentialPageLister: typeof import("./server-context.remote-tab-ops.harness.js").createSequentialPageLister;
  makeState: typeof import("./server-context.remote-tab-ops.harness.js").makeState;
  originalFetch: typeof import("./server-context.remote-tab-ops.harness.js").originalFetch;
};

async function loadRemoteProfileTestDeps(): Promise<RemoteProfileTestDeps> {
  vi.resetModules();
  await import("./server-context.chrome-test-harness.js");
  const chromeModule = await import("./chrome.js");
  const { InvalidBrowserNavigationUrlError } = await import("./navigation-guard.js");
  const pwAiModule = await import("./pw-ai-module.js");
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  const { createBrowserRouteContext } = await import("./server-context.js");
  const {
    createJsonListFetchMock,
    createRemoteRouteHarness,
    createSequentialPageLister,
    makeState,
    originalFetch,
  } = await import("./server-context.remote-tab-ops.harness.js");
  return {
    chromeModule,
    InvalidBrowserNavigationUrlError,
    pwAiModule,
    closePlaywrightBrowserConnection,
    createBrowserRouteContext,
    createJsonListFetchMock,
    createRemoteRouteHarness,
    createSequentialPageLister,
    makeState,
    originalFetch,
  };
}

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = deps.originalFetch;
});

afterEach(async () => {
  await deps.closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = deps.originalFetch;
  vi.restoreAllMocks();
});

describe("browser remote profile tab ops via Playwright", () => {
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

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

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

    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("rejects stale targetId for remote profiles even when only one tab remains", async () => {
    const responses = [
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
      [{ targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" }],
    ];
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
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
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = deps.createRemoteRouteHarness();

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
