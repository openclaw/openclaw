import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-support.js";

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock("./chrome.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./chrome.js")>();
  return {
    ...orig,
    isChromeCdpReady: vi.fn(async () => true),
    isChromeReachable: vi.fn(async () => true),
    launchOpenClawChrome: vi.fn(async () => {
      throw new Error("unexpected launch");
    }),
    resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw"),
    stopOpenClawChrome: vi.fn(async () => {}),
  };
});

import "./server-context.chrome-test-harness.js";
import * as cdpModule from "./cdp.js";
import * as chromeModule from "./chrome.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { createBrowserRouteContext } from "./server-context.js";
import {
  makeManagedTabsWithNew,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(async () => {
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function seedRunningProfileState(
  state: ReturnType<typeof makeState>,
  profileName = "openclaw",
): void {
  (state.profiles as Map<string, unknown>).set(profileName, {
    profile: { name: profileName },
    running: { pid: 1234, proc: { on: vi.fn() } },
    lastTargetId: null,
  });
}

async function expectOldManagedTabClose(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/json/close/OLD1"),
      expect.any(Object),
    );
  });
}

function createOldTabCleanupFetchMock(
  existingTabs: ReturnType<typeof makeManagedTabsWithNew>,
  params?: { rejectNewTabClose?: boolean },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const value = String(url);
    if (value.includes("/json/list")) {
      return { ok: true, json: async () => existingTabs } as unknown as Response;
    }
    if (value.includes("/json/close/OLD1")) {
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    if (params?.rejectNewTabClose && value.includes("/json/close/NEW")) {
      throw new Error("cleanup must not close NEW");
    }
    throw new Error(`unexpected fetch: ${value}`);
  });
}

function createManagedTabListFetchMock(params: {
  existingTabs: ReturnType<typeof makeManagedTabsWithNew>;
  onClose: (url: string) => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const value = String(url);
    if (value.includes("/json/list")) {
      return { ok: true, json: async () => params.existingTabs } as unknown as Response;
    }
    if (value.includes("/json/close/")) {
      return await params.onClose(value);
    }
    throw new Error(`unexpected fetch: ${value}`);
  });
}

async function openManagedTabWithRunningProfile(params: {
  fetchMock: ReturnType<typeof vi.fn>;
  url?: string;
}) {
  global.fetch = withFetchPreconnect(params.fetchMock);
  const state = makeState("openclaw");
  seedRunningProfileState(state);
  const ctx = createBrowserRouteContext({ getState: () => state });
  const openclaw = ctx.forProfile("openclaw");
  return await openclaw.openTab(params.url ?? "http://127.0.0.1:3009");
}

describe("browser server-context tab selection state", () => {
  it("updates lastTargetId when openTab is created via CDP", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => [
          {
            id: "CREATED",
            title: "New Tab",
            url: "http://127.0.0.1:8080",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:8080");
    expect(opened.targetId).toBe("CREATED");
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "http://127.0.0.1:8080",
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("closes excess managed tabs after opening a new tab", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createOldTabCleanupFetchMock(existingTabs);

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
  });

  it("never closes the just-opened managed tab during cap cleanup", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew({ newFirst: true });
    const fetchMock = createOldTabCleanupFetchMock(existingTabs, { rejectNewTabClose: true });

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/json/close/NEW"),
      expect.anything(),
    );
  });

  it("does not fail tab open when managed-tab cleanup list fails", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        listCount += 1;
        if (listCount === 1) {
          return {
            ok: true,
            json: async () => [
              {
                id: "NEW",
                title: "New Tab",
                url: "http://127.0.0.1:3009",
                webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
                type: "page",
              },
            ],
          } as unknown as Response;
        }
        throw new Error("/json/list timeout");
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    seedRunningProfileState(state);
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
  });

  it("does not run managed tab cleanup in attachOnly mode", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createManagedTabListFetchMock({
      existingTabs,
      onClose: () => {
        throw new Error("should not close tabs in attachOnly mode");
      },
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.attachOnly = true;
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/json/close/"),
      expect.anything(),
    );
  });

  it("does not block openTab on slow best-effort cleanup closes", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createManagedTabListFetchMock({
      existingTabs,
      onClose: (url) => {
        if (url.includes("/json/close/OLD1")) {
          return new Promise<Response>(() => {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    const opened = await Promise.race([
      openManagedTabWithRunningProfile({ fetchMock }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("openTab timed out waiting for cleanup")), 300),
      ),
    ]);

    expect(opened.targetId).toBe("NEW");
  });

  it("blocks unsupported non-network URLs before any HTTP tab-open fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.openTab("file:///etc/passwd")).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ensureTabAvailable recovers when newly opened tab initially lacks wsUrl", async () => {
    vi.spyOn(chromeModule, "isChromeReachable").mockResolvedValue(true);
    vi.spyOn(chromeModule, "isChromeCdpReady").mockResolvedValue(true);
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "FRESH" });

    let listCallCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      listCallCount++;
      // Call 1 (ensureTabAvailable initial listTabs): empty → triggers openTab
      if (listCallCount === 1) {
        return { ok: true, json: async () => [] } as unknown as Response;
      }
      // Call 2 (openTab discovery loop): tab with wsUrl so openTab returns
      if (listCallCount === 2) {
        return {
          ok: true,
          json: async () => [
            {
              id: "FRESH",
              title: "New Tab",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/FRESH",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      // Call 3 (ensureTabAvailable post-openTab listTabs): tab WITHOUT wsUrl
      if (listCallCount === 3) {
        return {
          ok: true,
          json: async () => [
            {
              id: "FRESH",
              title: "New Tab",
              url: "about:blank",
              // NO webSocketDebuggerUrl — simulates wsUrl lag
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      // Calls 4+: wsUrl polling recovery — wsUrl now populated
      return {
        ok: true,
        json: async () => [
          {
            id: "FRESH",
            title: "New Tab",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/FRESH",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const tab = await openclaw.ensureTabAvailable();
    expect(tab.targetId).toBe("FRESH");
    // Verify wsUrl polling actually recovered (not just targetId match)
    expect(tab.wsUrl).toBeDefined();
    // Polling happened: more calls than the initial 3 (initial + discovery + no-wsUrl)
    expect(listCallCount).toBeGreaterThan(3);
  });

  it("ensureTabAvailable falls back to tab without wsUrl after polling exhausts", async () => {
    vi.spyOn(chromeModule, "isChromeReachable").mockResolvedValue(true);
    vi.spyOn(chromeModule, "isChromeCdpReady").mockResolvedValue(true);
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NOWSURL" });

    let listCallCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      listCallCount++;
      // Call 1: empty → triggers openTab
      if (listCallCount === 1) {
        return { ok: true, json: async () => [] } as unknown as Response;
      }
      // Call 2 (openTab discovery): tab with wsUrl so openTab returns
      if (listCallCount === 2) {
        return {
          ok: true,
          json: async () => [
            {
              id: "NOWSURL",
              title: "Tab",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NOWSURL",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      // ALL subsequent calls: tab exists but NO wsUrl (simulates persistent wsUrl absence)
      return {
        ok: true,
        json: async () => [
          {
            id: "NOWSURL",
            title: "Tab",
            url: "about:blank",
            // NO webSocketDebuggerUrl
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const tab = await openclaw.ensureTabAvailable();
    // Should succeed by falling back to the tab without wsUrl
    expect(tab.targetId).toBe("NOWSURL");
    // Confirm fallback used unfiltered tab (no wsUrl)
    expect(tab.wsUrl).toBeUndefined();
    // Many polling calls should have happened before deadline exhausted
    expect(listCallCount).toBeGreaterThanOrEqual(5);
  }, 10000);

  it("ensureTabAvailable uses openTab result directly when listTabs stays empty", async () => {
    vi.spyOn(chromeModule, "isChromeReachable").mockResolvedValue(true);
    vi.spyOn(chromeModule, "isChromeCdpReady").mockResolvedValue(true);
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "GHOST" });

    let listCallCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      listCallCount++;
      // Call 2 (openTab discovery): tab found with wsUrl so openTab returns
      if (listCallCount === 2) {
        return {
          ok: true,
          json: async () => [
            {
              id: "GHOST",
              title: "Ghost",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/GHOST",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      // All other calls: empty
      return { ok: true, json: async () => [] } as unknown as Response;
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const tab = await openclaw.ensureTabAvailable();
    expect(tab.targetId).toBe("GHOST");
  });
});
