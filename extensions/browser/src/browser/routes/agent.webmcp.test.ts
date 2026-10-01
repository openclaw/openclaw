import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserWebMcpRoutes } from "./agent.webmcp.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({ contextId: "document-a", tools: [] })),
  before: vi.fn(async () => {}),
  after: vi.fn(async () => {}),
}));
vi.mock("../chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({ runChromeMcpWebMcp: mocks.run }),
}));
vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationResultAllowed: mocks.before,
  withBrowserNavigationPolicy: (ssrfPolicy: unknown) => ({ ssrfPolicy }),
}));
vi.mock("./agent.act.existing-session.js", () => ({
  assertExistingSessionPostInteractionNavigationAllowed: mocks.after,
}));

describe("WebMCP Browser routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.run.mockResolvedValue({ contextId: "document-a", tools: [] });
  });
  function setup(driver = "existing-session") {
    const profileCtx = {
      profile: { driver, name: "isolated", cdpUrl: "http://127.0.0.1:9222", cdpIsLoopback: true },
      ensureTabAvailable: vi.fn(async () => ({ targetId: "owned-a", url: "https://example.com" })),
      listTabs: vi.fn(async () => [{ targetId: "owned-a", url: "https://example.com" }]),
    };
    const ctx = {
      forProfile: vi.fn(() => profileCtx),
      mapTabError: () => null,
      state: () => ({ resolved: { actionTimeoutMs: 1000, ssrfPolicy: {} } }),
    } as unknown as BrowserRouteContext;
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserWebMcpRoutes(app, ctx);
    return {
      ctx,
      profileCtx,
      call: async (action: string, body: Record<string, unknown>) => {
        const response = createBrowserRouteResponse();
        await postHandlers.get(`/webmcp/${action}`)!(
          { params: {}, query: { profile: "isolated" }, body },
          response.res,
        );
        return response;
      },
    };
  }
  it("resolves the profile and target through existing route policy", async () => {
    const { ctx, profileCtx, call } = setup();
    const response = await call("list", { targetId: "label-a" });
    expect(ctx.forProfile).toHaveBeenCalledWith("isolated");
    expect(profileCtx.ensureTabAvailable).toHaveBeenCalledWith("label-a", expect.anything());
    expect(mocks.before).toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ profileName: "isolated", targetId: "owned-a" }),
      false,
    );
    expect(response.body).toMatchObject({ targetId: "owned-a", contextId: "document-a" });
  });
  it("rejects non-MCP profiles without running an action", async () => {
    const response = await setup("playwright").call("list", {});
    expect(response.statusCode).toBe(501);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each([{ toolName: "t" }, { contextId: "d" }, { contextId: "d", toolName: "t", input: [] }])(
    "rejects malformed execution requests",
    async (body) => {
      expect((await setup().call("execute", body)).statusCode).toBe(400);
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );
  it("does not dispatch when current URL policy rejects", async () => {
    mocks.before.mockRejectedValueOnce(new Error("URL blocked"));
    const response = await setup().call("list", {});
    expect(response.statusCode).toBe(500);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("checks post-interaction policy before returning success", async () => {
    mocks.after.mockRejectedValueOnce(new Error("navigation blocked"));
    const response = await setup().call("execute", { contextId: "d", toolName: "t", input: {} });
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ error: expect.stringContaining("navigation blocked") });
  });
  it("still checks post-interaction policy on uncertain execution failure", async () => {
    mocks.run.mockRejectedValueOnce(new Error("outcome unknown"));
    const response = await setup().call("execute", { contextId: "d", toolName: "t" });
    expect(mocks.after).toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
  });
  it("preserves uncertain outcome when the post-interaction policy also fails", async () => {
    mocks.run.mockRejectedValueOnce(new Error("outcome unknown; inspect before retrying"));
    mocks.after.mockRejectedValueOnce(new Error("navigation blocked"));
    const response = await setup().call("execute", { contextId: "d", toolName: "t" });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: expect.stringMatching(/outcome unknown.*navigation blocked/),
    });
  });
});
