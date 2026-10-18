import { describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserRoutes } from "./index.js";
import { withBrowserProfileCapabilities } from "./profile-capabilities.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";

function setup(engine: "chromium" | "lightpanda" = "lightpanda") {
  const profile = makeBrowserProfile({
    name: "selected",
    engine,
    cdpUrl: "ws://127.0.0.1:9222/",
    attachOnly: true,
  });
  const ensureTabAvailable = vi.fn(async () => {
    throw new Error("The unsupported operation reached the browser adapter");
  });
  const profileCtx = { profile, ensureTabAvailable } as unknown as ProfileContext;
  const ctx = {
    forProfile: vi.fn(() => profileCtx),
    state: () => makeBrowserServerState({ profile }),
  } as unknown as BrowserRouteContext;
  const routes = createBrowserRouteApp();
  const request = async (method: "get" | "post", path: string, input: Partial<BrowserRequest>) => {
    const handler = (method === "post" ? routes.postHandlers : routes.getHandlers).get(path);
    if (!handler) {
      throw new Error(`Route not registered: ${method} ${path}`);
    }
    const response = createBrowserRouteResponse();
    await handler({ params: {}, query: {}, ...input }, response.res);
    return response;
  };
  return { ctx, ensureTabAvailable, routes, request };
}

describe("browser engine route admission", () => {
  it.each([
    ["post", "/screenshot", {}],
    ["get", "/cookies", {}],
    ["post", "/act", { body: { kind: "batch", actions: [{ kind: "click" }] } }],
    ["post", "/act", { body: { kind: "wait", selector: "main" } }],
    ...[true, "1", "yes", " TRUE "].map(
      (labels) => ["get", "/snapshot", { query: { labels } }] as const,
    ),
    ...[{ format: "aria" }, { refs: "role" }, { selector: "main" }, { frame: "iframe" }].map(
      (query) => ["get", "/snapshot", { query }] as const,
    ),
  ] as const)(
    "rejects registered %s %s %j before browser adapter admission",
    async (method, path, input) => {
      const { ctx, ensureTabAvailable, routes, request } = setup();
      registerBrowserRoutes(routes.app, ctx);
      const response = await request(method, path, {
        ...input,
        query: { ...("query" in input ? input.query : {}), profile: "selected" },
      });
      expect(response.statusCode).toBe(501);
      expect(response.body).toMatchObject({
        code: "BROWSER_CAPABILITY_UNSUPPORTED",
        engine: "lightpanda",
      });
      expect(ensureTabAvailable).not.toHaveBeenCalled();
      expect(ctx.forProfile).toHaveBeenCalledWith("selected");
    },
  );

  it.each([
    ["lightpanda", "post", "/act", { body: { kind: "click", ref: "e1" } }],
    ["chromium", "post", "/act", { body: { kind: "wait", selector: "main" } }],
    ...[undefined, false, "0", "no", " FALSE "].map(
      (labels) =>
        [
          "lightpanda",
          "get",
          "/snapshot",
          { query: { labels, format: "ai", refs: "aria" } },
        ] as const,
    ),
  ] as const)("admits supported %s %s %s %j", async (engine, method, path, input) => {
    const { ctx, routes, request } = setup(engine);
    const adapter = vi.fn((_req: BrowserRequest, res: BrowserResponse) => res.json({ ok: true }));
    withBrowserProfileCapabilities(routes.app, ctx)[method](path, adapter);
    const response = await request(method, path, input);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledOnce();
  });

  it.each(["chromium", "lightpanda"] as const)(
    "applies %s policy to future routes",
    async (engine) => {
      const { ctx, routes, request } = setup(engine);
      const adapter = vi.fn();
      withBrowserProfileCapabilities(routes.app, ctx).post("/future-operation", adapter);
      const response = await request("post", "/future-operation", {});
      expect(adapter).toHaveBeenCalledTimes(engine === "chromium" ? 1 : 0);
      expect(response.statusCode).toBe(engine === "chromium" ? 200 : 501);
    },
  );
});
