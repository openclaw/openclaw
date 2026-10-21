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

function page(targetId: string, url = `https://${targetId.toLowerCase()}.example`) {
  return {
    targetId,
    title: targetId === "T1" ? "Tab 1" : targetId,
    url,
    type: "page" as const,
  };
}

async function expectBlockedCdpEndpoint(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect((error as { name?: unknown }).name).toBe("BrowserCdpEndpointBlockedError");
    expect((error as { status?: unknown }).status).toBe(400);
    return;
  }
  throw new Error("expected blocked browser CDP endpoint");
}

const permissiveRemoteCdpPolicy = {
  allowPrivateNetwork: true,
  allowedHostnames: ["1.1.1.1"],
};

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

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("/json/version");
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl:
            "wss://1.1.1.1:9222/devtools/browser/REMOTE-BROWSER?auth=fixture-value",
        }),
      } as unknown as Response;
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    // Enumeration budget falls back to the action-level timeout, not the
    // CDP handshake, so a tab-heavy session is not mistaken for a dead relay.
    expect(listPagesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      ssrfPolicy: permissiveRemoteCdpPolicy,
      timeoutMs: 60_000,
    });

    const opened = await remote.openTab("http://127.0.0.1:3000", { timeoutMs: 60_000 });
    expect(opened.targetId).toBe("T2");
    expect((opened as { ownership?: unknown }).ownership).toMatchObject({
      status: "durable",
      nativeTargetId: "T2",
      profileFingerprint: expect.stringMatching(/^sha256:/),
      browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      url: "http://127.0.0.1:3000",
      timeoutMs: 60_000,
      cdpPolicy: permissiveRemoteCdpPolicy,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      targetId: "T1",
      ssrfPolicy: permissiveRemoteCdpPolicy,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards a caller-supplied enumeration deadline instead of the handshake timeout", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            webSocketDebuggerUrl:
              "wss://1.1.1.1:9222/devtools/browser/REMOTE-BROWSER?auth=fixture-value",
          }),
        }) as unknown as Response,
    );
    const { remote } = deps.createRemoteRouteHarness(fetchMock);

    await remote.listTabs({ timeoutMs: 45_000 });

    expect(listPagesViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
  });

  it("preserves ownership cancellation when closing the exact created page fails", async () => {
    const close = vi.fn(async () => {
      throw new Error("created page close failed");
    });
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      createPageViaPlaywright: vi.fn(async () => ({ ...page("T2"), close })),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/json/close/T2")) {
        return new Response(null, { status: 404 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        markProbeStarted();
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error
                ? init.signal.reason
                : new Error("ownership version probe aborted"),
            ),
          { once: true },
        );
      });
    });
    const { remote } = deps.createRemoteRouteHarness(fetchMock);
    const controller = new AbortController();
    const abortError = new Error("caller aborted ownership probe");

    const opening = remote.openTab("https://t2.example", { signal: controller.signal });
    await probeStarted;
    controller.abort(abortError);

    await expect(opening).rejects.toBe(abortError);
    expect(close).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/json/version"),
    ]);
  });

  it("assigns stable tab ids and resolves labels", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      page("A", "https://example.com"),
      page("B", "https://docs.example.com"),
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["B", "t2"],
    ]);
    expect(tabs.map((tab) => tab.suggestedTargetId)).toEqual(["t1", "t2"]);

    const labeled = await remote.labelTab("t2", "docs");
    expect(labeled).toMatchObject({
      targetId: "B",
      suggestedTargetId: "docs",
      tabId: "t2",
      label: "docs",
    });

    await remote.focusTab("docs");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      targetId: "B",
      ssrfPolicy: permissiveRemoteCdpPolicy,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("B");

    await remote.labelTab("t1", "B");
    await expect(remote.focusTab("B")).rejects.toThrow("ambiguous browser tab reference");
    await remote.focusTab("B", { exactTargetId: true });
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetId: "B" }),
    );
  });

  it("migrates only unique URL groups alongside ambiguous duplicate groups", async () => {
    let currentPages = [
      page("A", "https://unique.example"),
      page("B", "https://duplicate.example"),
      page("C", "https://duplicate.example"),
    ];
    const listPagesViaPlaywright = vi.fn(async () => currentPages);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    expect((await remote.listTabs()).map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["B", "t2"],
      ["C", "t3"],
    ]);
    await remote.labelTab("t1", "unique");
    state.profiles.get("remote")!.lastTargetId = "A";

    currentPages = [
      page("D", "https://unique.example"),
      page("E", "https://duplicate.example"),
      page("F", "https://duplicate.example"),
    ];

    await expect(remote.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "D",
        tabId: "t1",
        label: "unique",
        suggestedTargetId: "unique",
      }),
      expect.objectContaining({ targetId: "E", tabId: "t4", suggestedTargetId: "t4" }),
      expect.objectContaining({ targetId: "F", tabId: "t5", suggestedTargetId: "t5" }),
    ]);
    expect(state.profiles.get("remote")?.lastTargetId).toBe("D");
  });

  it("opens a real remote Playwright tab when only browser-internal targets are listed", async () => {
    const internalTab = {
      targetId: "OMNI",
      title: "Omnibox Popup",
      url: "chrome://omnibox-popup.top-chrome/",
      type: "page" as const,
    };
    const realTab = {
      targetId: "REAL",
      title: "New Tab",
      url: "about:blank",
      type: "page" as const,
    };
    const listPagesViaPlaywright = vi.fn(
      deps.createSequentialPageLister([[internalTab], [internalTab, realTab]]),
    );
    const createPageViaPlaywright = vi.fn(async () => realTab);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    const selected = await remote.ensureTabAvailable();
    expect(selected.targetId).toBe("REAL");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("REAL");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      url: "about:blank",
      cdpPolicy: permissiveRemoteCdpPolicy,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("does not open a blank tab when page target identities are unavailable", async () => {
    const listPagesViaPlaywright = vi.fn(async () => {
      throw new Error("Playwright page target identities are temporarily unavailable.");
    });
    const createPageViaPlaywright = vi.fn(async () => page("WRONG", "about:blank"));
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = deps.createRemoteRouteHarness();

    await expect(remote.ensureTabAvailable()).rejects.toThrow(/target identities.*unavailable/i);
    expect(createPageViaPlaywright).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the last complete list when a later enumeration is unavailable", async () => {
    const complete = [page("A", "https://a.example"), page("B", "https://b.example")];
    const listPagesViaPlaywright = vi
      .fn<() => Promise<typeof complete>>()
      .mockResolvedValueOnce(complete)
      .mockRejectedValueOnce(
        new Error("Playwright page target identities are temporarily unavailable."),
      );
    const createPageViaPlaywright = vi.fn(async () => page("WRONG", "about:blank"));
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    const { remote } = deps.createRemoteRouteHarness();

    await expect(remote.ensureTabAvailable("B")).resolves.toMatchObject({ targetId: "B" });
    expect(createPageViaPlaywright).not.toHaveBeenCalled();
  });

  it("blocks remote Playwright tab operations when strict SSRF hostname allowlist rejects the cdpUrl", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const state = deps.makeState("remote");
    state.resolved.ssrfPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["browserless.example.com"],
    };
    const remoteProfile = expectDefined(state.resolved.profiles.remote, "remote browser profile");
    state.resolved.profiles.remote = {
      ...remoteProfile,
      cdpUrl: "http://10.0.0.42:9222",
      cdpPort: 9222,
    };
    const ctx = deps.createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    await expectBlockedCdpEndpoint(remote.listTabs());
    await expectBlockedCdpEndpoint(remote.focusTab("T1"));
    await expectBlockedCdpEndpoint(remote.closeTab("T1"));
    expect(listPagesViaPlaywright).not.toHaveBeenCalled();
    expect(focusPageByTargetIdViaPlaywright).not.toHaveBeenCalled();
    expect(closePageByTargetIdViaPlaywright).not.toHaveBeenCalled();
  });
});

function mockExtensionPage(targetIds = ["TARGET-41"]): void {
  vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
    listPagesViaPlaywright: vi.fn(async () =>
      targetIds.map((targetId) => ({
        targetId,
        title: "Extension test",
        url: "https://example.com/login",
        type: "page",
      })),
    ),
  } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
}

function createExtensionProfile() {
  const state = deps.makeState("openclaw");
  state.resolved.defaultProfile = "chrome";
  state.resolved.profiles.chrome = {
    cdpUrl: "http://127.0.0.1:18799",
    cdpPort: 18799,
    color: "#FF4500",
    driver: "extension",
  };
  return deps
    .createTestBrowserRouteContext({
      getState: () => state,
    })
    .forProfile("chrome");
}

describe("browser extension profile tab ops", () => {
  it("matches native ids by CDP target despite identical page metadata and different order", async () => {
    mockExtensionPage(["TARGET-41", "TARGET-42", "TARGET-43"]);
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        [42, 99, 41, 43].map((tabId) => ({
          id: `TARGET-${tabId}`,
          tabId: tabId === 43 ? "43" : tabId,
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        })),
      ),
    );

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toEqual([
      expect.objectContaining({
        targetId: "TARGET-41",
        tabId: "t1",
        webExtensionTabId: 41,
      }),
      expect.objectContaining({
        targetId: "TARGET-42",
        tabId: "t2",
        webExtensionTabId: 42,
      }),
      expect.objectContaining({ targetId: "TARGET-43", tabId: "t3" }),
    ]);
    expect(tabs[2]).not.toHaveProperty("webExtensionTabId");
  });

  it("preserves caller cancellation during the native extension metadata request", async () => {
    mockExtensionPage();
    const controller = new AbortController();
    const reason = new Error("tab listing cancelled");
    let fetchSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      fetchSignal = init?.signal;
      controller.abort(reason);
      throw reason;
    });

    await expect(createExtensionProfile().listTabs({ signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fetchSignal?.aborted).toBe(true);
  });
});

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
