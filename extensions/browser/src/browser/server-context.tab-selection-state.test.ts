import { lookup as dnsLookup } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import * as cdpHelpers from "./cdp.helpers.js";
import * as cdp from "./cdp.js";
import { BrowserTargetAmbiguousError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  createTestBrowserRouteContext,
  makeManagedTabsWithNew,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";
import { mockLaunchedChrome } from "./server-context.test-harness.js";
import * as sessionTabStore from "./session-tab-store.js";

afterEach(async () => {
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockCreatedTarget(targetId: string, finalUrl: string) {
  return vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({ targetId, finalUrl });
}

function page(id: string, url = "about:blank", title = id) {
  return {
    id,
    title,
    url,
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/" + id,
    type: "page",
  };
}

function setup(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  state = makeState("openclaw"),
) {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => fetcher(String(url), init));
  globalThis.fetch = withBrowserFetchPreconnect(fetchMock);
  const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  return { state, openclaw, runtime: state.profiles.get("openclaw")!, fetchMock };
}

function listOnly(tabs: () => ReturnType<typeof page>[]) {
  return setup(async (url) => {
    if (url.includes("/json/list")) {
      return Response.json(tabs());
    }
    throw new Error("unexpected fetch: " + url);
  });
}

async function labeled() {
  const harness = setup(async (url) => {
    if (url.includes("/json/list")) {
      return Response.json([page("ABCDEF123456"), page("ABC999")]);
    }
    if (url.includes("/json/activate/") || url.includes("/json/close/")) {
      return new Response();
    }
    throw new Error("unexpected fetch: " + url);
  });
  await harness.openclaw.labelTab("ABCDEF123456", "docs");
  await harness.openclaw.labelTab("ABC999", "app");
  return harness;
}

describe("browser tab selection and ownership", () => {
  it("preserves a disappeared sticky alias when a newly discovered tab is blocked", async () => {
    const create = vi
      .spyOn(cdp, "createTargetViaCdp")
      .mockResolvedValueOnce({ targetId: "GOOD", finalUrl: "about:blank" })
      .mockResolvedValueOnce({ targetId: "BLOCKED", finalUrl: "https://example.com" });
    const closeRequests: string[] = [];
    const { openclaw, state, runtime } = setup(async (url) => {
      if (url.includes("/json/list")) {
        return Response.json([
          create.mock.calls.length === 1 ? page("GOOD") : page("BLOCKED", "http://127.0.0.1:9/"),
        ]);
      }
      if (url.includes("/json/close/")) {
        closeRequests.push(url);
        return new Response();
      }
      throw new Error("unexpected fetch: " + url);
    });
    state.resolved.ssrfPolicy = {};
    await openclaw.openTab("about:blank", { label: "good" });
    const aliases = structuredClone(runtime.tabAliases);
    await expect(openclaw.openTab("https://example.com", { label: "blocked" })).rejects.toThrow(
      /private|blocked|ssrf/i,
    );
    expect(runtime.lastTargetId).toBe("GOOD");
    expect(runtime.tabAliases).toEqual(aliases);
    expect(runtime.tabAliases?.byTargetId).toEqual({
      GOOD: { tabId: "t1", label: "good", url: "about:blank" },
    });
    expect(closeRequests).toEqual(["http://127.0.0.1:18800/json/close/BLOCKED"]);
  });

  it("returns an undiscovered target without adopting or cleaning it", async () => {
    vi.useFakeTimers();
    mockCreatedTarget("UNDISCOVERED", "https://example.com/final");
    const { openclaw, runtime, fetchMock } = listOnly(() => [page("GOOD")]);
    runtime.running = mockLaunchedChrome(vi.fn(), 1234);
    await openclaw.listTabs();
    runtime.lastTargetId = "GOOD";
    const aliases = structuredClone(runtime.tabAliases);
    const opening = openclaw.openTab("https://example.com/start", { label: "undiscovered" });
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(opening).resolves.toEqual({
      targetId: "UNDISCOVERED",
      title: "",
      url: "https://example.com/final",
      type: "page",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
    });
    expect(runtime.lastTargetId).toBe("GOOD");
    expect(runtime.tabAliases).toEqual(aliases);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/json/close/"))).toBe(false);
    await expect(openclaw.ensureTabAvailable()).resolves.toMatchObject({
      targetId: "GOOD",
      tabId: "t1",
    });
  });

  it.each(["CDP", "HTTP"] as const)(
    "does not adopt a %s target without a committed navigation",
    async (transport) => {
      const create = vi.spyOn(cdp, "createTargetViaCdp");
      if (transport === "CDP") {
        create.mockResolvedValue({ targetId: "UNSETTLED" });
      } else {
        create.mockRejectedValue(new Error("cdp unavailable"));
        vi.spyOn(cdp, "waitForCdpCommittedNavigationUrl").mockResolvedValue(undefined);
        vi.spyOn(cdpHelpers, "fetchJson").mockResolvedValueOnce(
          page("UNSETTLED", "https://example.com"),
        );
      }
      const { openclaw, runtime, fetchMock } = setup(async () => {
        throw new Error("unexpected discovery or cleanup");
      });
      runtime.running = mockLaunchedChrome(vi.fn(), 1234);
      runtime.lastTargetId = "GOOD";
      runtime.tabAliases = {
        nextTabNumber: 2,
        byTargetId: { GOOD: { tabId: "t1", label: "good", url: "about:blank" } },
      };
      const aliases = structuredClone(runtime.tabAliases);
      await expect(
        openclaw.openTab("https://example.com", { label: "unsettled" }),
      ).resolves.toEqual({
        targetId: "UNSETTLED",
        title: transport === "CDP" ? "" : "UNSETTLED",
        ...(transport === "HTTP" ? { wsUrl: "ws://127.0.0.1:18800/devtools/page/UNSETTLED" } : {}),
        url: "https://example.com",
        type: "page",
        ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      });
      expect(runtime.lastTargetId).toBe("GOOD");
      expect(runtime.tabAliases).toEqual(aliases);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects invalid labels before any browser mutation", async () => {
    const create = vi.spyOn(cdp, "createTargetViaCdp");
    const { openclaw, runtime, fetchMock } = listOnly(() => []);
    await expect(openclaw.openTab("about:blank", { label: "not allowed" })).rejects.toThrow(
      /tab label/i,
    );
    expect(create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.tabAliases).toBeUndefined();
  });

  it("retains dashboard and just-opened tabs when evicting excess managed tabs", async () => {
    vi.spyOn(sessionTabStore, "readBrowserDashboardTabs").mockResolvedValue([
      {
        version: 1,
        sessionKey: "agent:main:main",
        nativeTargetId: "OLD1",
        profile: "openclaw",
        profileFingerprint: "profile",
        browserInstanceFingerprint: "browser",
        interactionTargetKind: "native",
        trackedAt: 1,
        lastUsedAt: 1,
        storageKey: "retained-old1",
        dashboard: {
          sessionKey: "agent:main:main",
          agentId: "main",
          name: "service",
          instanceId: "widget-one",
          url: "http://service.example/",
          state: "active",
        },
      },
    ]);
    mockCreatedTarget("NEW", "http://127.0.0.1:3009");
    const closed: string[] = [];
    const cleanup = Promise.withResolvers<void>();
    const { openclaw, runtime } = setup(async (url) => {
      if (url.includes("/json/list")) {
        return Response.json(makeManagedTabsWithNew({ newFirst: true }));
      }
      if (url.includes("/json/version")) {
        return Response.json({
          webSocketDebuggerUrl:
            "ws://127.0.0.1:18800/devtools/browser/MANAGED-BROWSER?auth=fixture-value",
        });
      }
      if (url.includes("/json/close/")) {
        closed.push(url);
        cleanup.resolve();
        return new Response();
      }
      throw new Error("unexpected fetch: " + url);
    });
    runtime.running = mockLaunchedChrome(vi.fn(), 1234);
    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened).toMatchObject({
      targetId: "NEW",
      ownership: {
        status: "durable",
        nativeTargetId: "NEW",
        profileFingerprint: expect.stringMatching(/^sha256:/),
        browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
      },
    });
    expect(runtime.lastTargetId).toBe("NEW");
    await cleanup.promise;
    expect(closed).toEqual(["http://127.0.0.1:18800/json/close/OLD2"]);
  });

  it("does not block opening on an ordinary managed-tab cleanup close", async () => {
    mockCreatedTarget("NEW", "http://127.0.0.1:3009");
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<Response>();
    const requests: string[] = [];
    const { openclaw, runtime } = setup(async (url) => {
      if (url.includes("/json/list")) {
        return Response.json(makeManagedTabsWithNew());
      }
      if (url.includes("/json/close/OLD1")) {
        requests.push(url);
        started.resolve();
        return closed.promise;
      }
      throw new Error("unexpected fetch: " + url);
    });
    runtime.running = mockLaunchedChrome(vi.fn(), 1234);
    try {
      expect((await openclaw.openTab("http://127.0.0.1:3009")).targetId).toBe("NEW");
      await started.promise;
      expect(requests).toEqual(["http://127.0.0.1:18800/json/close/OLD1"]);
    } finally {
      closed.resolve(new Response());
    }
  });

  it("does not clean up tabs in an attach-only browser", async () => {
    mockCreatedTarget("NEW", "about:blank");
    const state = makeState("openclaw");
    state.resolved.attachOnly = true;
    const { openclaw, runtime, fetchMock } = setup(async (url) => {
      if (url.includes("/json/list")) {
        return Response.json(makeManagedTabsWithNew());
      }
      throw new Error("unexpected fetch: " + url);
    }, state);
    runtime.running = mockLaunchedChrome(vi.fn(), 1234);
    expect((await openclaw.openTab("about:blank")).targetId).toBe("NEW");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/json/close/"))).toBe(false);
  });

  it("blocks file URLs before HTTP tab creation", async () => {
    const { openclaw, fetchMock } = listOnly(() => []);
    await expect(openclaw.openTab("file:///etc/passwd")).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adopts the committed target after the HTTP 405 creation fallback", async () => {
    vi.spyOn(cdp, "createTargetViaCdp").mockRejectedValue(new Error("cdp unavailable"));
    const committed = vi
      .spyOn(cdp, "waitForCdpCommittedNavigationUrl")
      .mockResolvedValue("https://example.com");
    const fetchJson = vi
      .spyOn(cdpHelpers, "fetchJson")
      .mockRejectedValueOnce(new Error("HTTP 405"))
      .mockResolvedValueOnce(page("NEW", "https://example.com"));
    const { state, openclaw, runtime } = listOnly(() => []);
    state.resolved.ssrfPolicy = {};
    await expect(openclaw.openTab("https://example.com", { label: "raw" })).resolves.toMatchObject({
      targetId: "NEW",
      tabId: "t1",
      label: "raw",
      suggestedTargetId: "raw",
    });
    expect(runtime.lastTargetId).toBe("NEW");
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({ requestedUrl: "https://example.com" }),
    );
    const endpoint = "http://127.0.0.1:18800/json/new?https%3A%2F%2Fexample.com";
    expect(fetchJson.mock.calls.slice(0, 2)).toEqual([
      [endpoint, CDP_JSON_NEW_TIMEOUT_MS, { method: "PUT" }, undefined],
      [endpoint, CDP_JSON_NEW_TIMEOUT_MS, undefined, undefined],
    ]);
  });

  it("rejects a raw target whose committed URL is blocked", async () => {
    vi.spyOn(cdp, "createTargetViaCdp").mockRejectedValue(new Error("cdp unavailable"));
    vi.spyOn(cdp, "waitForCdpCommittedNavigationUrl").mockResolvedValue(
      "http://127.0.0.1:9/blocked",
    );
    vi.spyOn(cdpHelpers, "fetchJson").mockResolvedValue(page("RAW_BLOCKED", "https://example.com"));
    const { state, openclaw, runtime } = listOnly(() => []);
    state.resolved.ssrfPolicy = {};
    await expect(openclaw.openTab("https://example.com", { label: "blocked" })).rejects.toThrow(
      /private|blocked|ssrf/i,
    );
    expect(runtime.lastTargetId).toBeNull();
    expect(runtime.tabAliases).toBeUndefined();
  });

  it("preserves the opened WebSocket lookup when the same-target relist omits it", async () => {
    vi.spyOn(cdp, "createTargetViaCdp").mockRejectedValue(new Error("raw create failed"));
    vi.spyOn(cdp, "waitForCdpCommittedNavigationUrl").mockResolvedValue(undefined);
    let listCalls = 0;
    vi.spyOn(cdpHelpers, "fetchJson").mockImplementation(async (url) => {
      if (url.includes("/json/list")) {
        return ++listCalls === 1
          ? []
          : [{ id: "NEW", title: "Listed", url: "about:blank", type: "page" }];
      }
      if (url.includes("/json/new")) {
        return {
          ...page("NEW"),
          title: "Opened",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
        };
      }
      throw new Error("unexpected fetchJson: " + url);
    });
    const dns = { lookup: dnsLookup };
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {});
    vi.spyOn(cdpHelpers, "assertCdpEndpointAllowed").mockResolvedValue({
      hostname: "browser.example",
      addresses: ["127.0.0.1"],
      lookup: dns.lookup,
    });
    const { state, openclaw } = listOnly(() => []);
    state.resolved.ssrfPolicy = {};
    const selected = await openclaw.ensureTabAvailable();
    expect(selected).toMatchObject({
      targetId: "NEW",
      title: "Listed",
      url: "about:blank",
      wsUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
    });
    expect(selected.wsLookup).toBeTypeOf("function");
    selected.wsLookup?.("browser.example", {}, () => {});
    expect(lookup).toHaveBeenCalledWith("browser.example", {}, expect.any(Function));
  });

  it("expires ambiguous duplicate-URL aliases but preserves a later one-for-one replacement", async () => {
    const same = "https://app.example/same";
    let targets = [page("OLD_LEFT", same), page("OLD_RIGHT", same)];
    const { openclaw, runtime } = listOnly(() => targets);
    expect((await openclaw.listTabs()).map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["OLD_LEFT", "t1"],
      ["OLD_RIGHT", "t2"],
    ]);
    await openclaw.labelTab("t1", "left");
    await openclaw.labelTab("t2", "right");
    runtime.lastTargetId = "OLD_LEFT";
    targets = [page("NEW_RIGHT", same), page("NEW_LEFT", same)];
    await expect(openclaw.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "NEW_RIGHT", tabId: "t3", suggestedTargetId: "t3" }),
      expect.objectContaining({ targetId: "NEW_LEFT", tabId: "t4", suggestedTargetId: "t4" }),
    ]);
    expect(runtime.lastTargetId).toBe("OLD_LEFT");
    await expect(openclaw.ensureTabAvailable("left")).rejects.toThrow(/tab not found/i);
    await expect(openclaw.ensureTabAvailable()).rejects.toThrow(/tab not found/i);
    await openclaw.labelTab("t3", "fresh-right");
    targets = [page("NEW_LEFT", same), page("NEWER_RIGHT", same)];
    await expect(openclaw.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "NEW_LEFT", tabId: "t4" }),
      expect.objectContaining({
        targetId: "NEWER_RIGHT",
        tabId: "t3",
        label: "fresh-right",
        suggestedTargetId: "fresh-right",
      }),
    ]);
  });

  it("rejects non-durable dashboard ownership and closes through the captured endpoint", async () => {
    mockCreatedTarget("CREATED", "http://127.0.0.1:8080");
    const closed: string[] = [];
    const { state, openclaw, fetchMock } = setup(async (url) => {
      if (url.includes("/json/list")) {
        return Response.json([page("CREATED", "http://127.0.0.1:8080")]);
      }
      if (url.includes("/json/version")) {
        state.resolved.profiles.openclaw = {
          driver: "existing-session",
          cdpUrl: "http://127.0.0.1:19999",
          color: "#FF4500",
        };
        return Response.json({});
      }
      if (url.includes("/json/close/CREATED")) {
        closed.push(url);
        return new Response();
      }
      throw new Error("unexpected fetch: " + url);
    });
    await expect(
      openclaw.openTab("http://127.0.0.1:8080", { requireDurableOwnership: true }),
    ).rejects.toThrow(/could not verify durable ownership/);
    expect(closed).toEqual(["http://127.0.0.1:18800/json/close/CREATED"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":19999"))).toBe(false);
  });

  it("propagates abort through the ownership probe even when cleanup fails", async () => {
    mockCreatedTarget("CREATED", "http://127.0.0.1:8080");
    const started = Promise.withResolvers<void>();
    let versionSignal: AbortSignal | null | undefined;
    const closed: string[] = [];
    const { openclaw } = setup(async (url, init) => {
      if (url.includes("/json/list")) {
        return Response.json([page("CREATED", "http://127.0.0.1:8080")]);
      }
      if (url.includes("/json/version")) {
        versionSignal = init?.signal;
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          versionSignal?.addEventListener(
            "abort",
            () =>
              reject(
                versionSignal?.reason instanceof Error
                  ? versionSignal.reason
                  : new Error("ownership probe aborted"),
              ),
            { once: true },
          );
        });
      }
      if (url.includes("/json/close/CREATED")) {
        closed.push(url);
        throw new Error("close request failed");
      }
      throw new Error("unexpected fetch: " + url);
    });
    const controller = new AbortController();
    const error = new Error("caller aborted managed ownership probe");
    const opening = openclaw.openTab("http://127.0.0.1:8080", { signal: controller.signal });
    await started.promise;
    controller.abort(error);
    expect(versionSignal?.aborted).toBe(true);
    await expect(opening).rejects.toBe(error);
    expect(closed).toEqual(["http://127.0.0.1:18800/json/close/CREATED"]);
  });

  it("resolves a case-insensitive raw prefix at every operation boundary", async () => {
    const label = await labeled();
    expect((await label.openclaw.labelTab("abcdef", "parity")).targetId).toBe("ABCDEF123456");
    const ensure = await labeled();
    expect((await ensure.openclaw.ensureTabAvailable("abcdef")).targetId).toBe("ABCDEF123456");
    const focus = await labeled();
    await focus.openclaw.focusTab("abcdef");
    expect(
      focus.fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/json/activate/ABCDEF123456"),
      ),
    ).toBe(true);
    const close = await labeled();
    expect(await close.openclaw.closeTab("abcdef")).toBe("ABCDEF123456");
    expect(
      close.fetchMock.mock.calls.some(([url]) => String(url).endsWith("/json/close/ABCDEF123456")),
    ).toBe(true);
  });

  it("rejects ambiguous raw prefixes at every operation boundary", async () => {
    const label = await labeled();
    await expect(label.openclaw.labelTab("ABC", "parity")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const ensure = await labeled();
    await expect(ensure.openclaw.ensureTabAvailable("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const focus = await labeled();
    await expect(focus.openclaw.focusTab("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
    const close = await labeled();
    await expect(close.openclaw.closeTab("ABC")).rejects.toBeInstanceOf(
      BrowserTargetAmbiguousError,
    );
  });
});
