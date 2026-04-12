import { describe, expect, it, vi } from "vitest";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

function createProfileContext(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
  return {
    ...baseProfileContext(),
    ...overrides,
  };
}

function baseProfileContext() {
  return {
    profile: {
      name: "openclaw",
    },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    isHttpReachable: vi.fn(async () => true),
    isReachable: vi.fn(async () => true),
    listTabs: vi.fn(async () => [
      {
        targetId: "T1",
        title: "Tab 1",
        url: "https://example.com",
        type: "page",
      },
    ]),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page",
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "" })),
  };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    state: () => ({ resolved: { ssrfPolicy: undefined } }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(() => null),
    ensureBrowserAvailable: profileCtx.ensureBrowserAvailable,
    ensureTabAvailable: profileCtx.ensureTabAvailable,
    isHttpReachable: profileCtx.isHttpReachable,
    isReachable: profileCtx.isReachable,
    listTabs: profileCtx.listTabs,
    openTab: profileCtx.openTab,
    focusTab: profileCtx.focusTab,
    closeTab: profileCtx.closeTab,
    stopRunningBrowser: profileCtx.stopRunningBrowser,
    resetProfile: profileCtx.resetProfile,
  };
}

async function callTabsAction(params: {
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(app, createRouteContext(params.profileCtx) as never);
  const handler = postHandlers.get("/tabs/action");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body: params.body }, response.res);
  return response;
}

describe("browser tab routes", () => {
  it("returns browser-not-running for close when the browser is not reachable", async () => {
    const profileCtx = createProfileContext({
      isReachable: vi.fn(async () => false),
    });

    const response = await callTabsAction({
      body: { action: "close", index: 0 },
      profileCtx,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "browser not running" });
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("returns browser-not-running for select when the browser is not reachable", async () => {
    const profileCtx = createProfileContext({
      isReachable: vi.fn(async () => false),
    });

    const response = await callTabsAction({
      body: { action: "select", index: 0 },
      profileCtx,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "browser not running" });
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });
});
