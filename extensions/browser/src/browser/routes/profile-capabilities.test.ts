import { describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserRoutes } from "./index.js";
import { withBrowserProfileCapabilities } from "./profile-capabilities.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

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
    mapTabError: () => null,
  } as unknown as BrowserRouteContext;
  return { ctx, ensureTabAvailable };
}

describe("browser engine route admission", () => {
  it.each([
    ["post", "/screenshot", {}],
    ["post", "/pdf", {}],
    ["post", "/download", {}],
    ["post", "/wait/download", {}],
    ["post", "/hooks/file-chooser", {}],
    ["post", "/hooks/dialog", {}],
    ["post", "/screencast", {}],
    ["post", "/set/device", {}],
    ["get", "/cookies", {}],
    ["get", "/storage/:kind", {}],
    ["get", "/console", {}],
    ["get", "/requests", {}],
    ["get", "/errors", {}],
    ["post", "/act", { kind: "batch", actions: [{ kind: "click" }] }],
    ["post", "/act", { kind: "clickCoords", x: 10, y: 20 }],
    ["post", "/act", { kind: "drag", startRef: "e1", endRef: "e2" }],
    ["post", "/act", { kind: "resize", width: 800, height: 600 }],
    ["post", "/act", { kind: "wait", selector: "main" }],
    ["post", "/act", { kind: "click", selector: "button" }],
    ["post", "/act", { kind: "type", selector: "input", text: "hello" }],
    ["post", "/act", { kind: "select", selector: "select", values: ["first"] }],
  ] as const)(
    "rejects registered %s %s before browser adapter admission",
    async (method, path, body) => {
      const { ctx, ensureTabAvailable } = setup();
      const routes = createBrowserRouteApp();
      registerBrowserRoutes(routes.app, ctx);
      const handler = (method === "post" ? routes.postHandlers : routes.getHandlers).get(path);
      if (!handler) {
        throw new Error(`Route not registered: ${method} ${path}`);
      }
      const response = createBrowserRouteResponse();

      await handler(
        { params: { kind: "local" }, query: { profile: "selected" }, body },
        response.res,
      );

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
    ["lightpanda", { kind: "click", ref: "e1" }],
    ["lightpanda", { kind: "wait", timeMs: 0 }],
    ["chromium", { kind: "wait", selector: "main" }],
  ] as const)("preserves supported %s action %j", async (engine, body) => {
    const { ctx } = setup(engine);
    const routes = createBrowserRouteApp();
    const adapter = vi.fn(
      (_req: BrowserRequest, res: ReturnType<typeof createBrowserRouteResponse>["res"]) =>
        res.json({ ok: true }),
    );
    withBrowserProfileCapabilities(routes.app, ctx).post("/act", adapter);
    const response = createBrowserRouteResponse();
    await routes.postHandlers.get("/act")?.({ params: {}, query: {}, body }, response.res);
    expect(response.statusCode).toBe(200);
    expect(adapter).toHaveBeenCalledOnce();
  });

  it.each([true, "true", "1", "yes", " TRUE "])(
    "rejects labeled snapshots (%s) before adapter admission",
    async (labels) => {
      const { ctx, ensureTabAvailable } = setup();
      const routes = createBrowserRouteApp();
      registerBrowserRoutes(routes.app, ctx);
      const handler = routes.getHandlers.get("/snapshot");
      if (!handler) {
        throw new Error("Snapshot route not registered");
      }
      const response = createBrowserRouteResponse();
      await handler({ params: {}, query: { labels } }, response.res);
      expect(response.statusCode).toBe(501);
      expect(ensureTabAvailable).not.toHaveBeenCalled();
    },
  );

  it.each([{ format: "aria" }, { refs: "role" }, { selector: "main" }, { frame: "iframe" }])(
    "rejects unsupported native snapshot mode %j",
    async (query) => {
      const { ctx, ensureTabAvailable } = setup();
      const routes = createBrowserRouteApp();
      registerBrowserRoutes(routes.app, ctx);
      const handler = routes.getHandlers.get("/snapshot");
      if (!handler) {
        throw new Error("Snapshot route not registered");
      }
      const response = createBrowserRouteResponse();
      await handler({ params: {}, query }, response.res);
      expect(response.statusCode).toBe(501);
      expect(ensureTabAvailable).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false, "false", "0", "no", " FALSE "])(
    "allows supported unlabeled snapshots (%s)",
    async (labels) => {
      const { ctx } = setup();
      const routes = createBrowserRouteApp();
      const adapter = vi.fn(
        (_req: BrowserRequest, res: ReturnType<typeof createBrowserRouteResponse>["res"]) =>
          res.json({ ok: true }),
      );
      withBrowserProfileCapabilities(routes.app, ctx).get("/snapshot", adapter);
      const response = createBrowserRouteResponse();
      await routes.getHandlers.get("/snapshot")?.(
        { params: {}, query: { labels, format: "ai", refs: "aria" } },
        response.res,
      );
      expect(response.statusCode).toBe(200);
      expect(adapter).toHaveBeenCalledOnce();
    },
  );

  it("leaves Chromium operations unrestricted and fails closed for future Lightpanda routes", async () => {
    for (const engine of ["chromium", "lightpanda"] as const) {
      const { ctx } = setup(engine);
      const routes = createBrowserRouteApp();
      const adapter = vi.fn();
      withBrowserProfileCapabilities(routes.app, ctx).post("/future-operation", adapter);
      const response = createBrowserRouteResponse();
      await routes.postHandlers.get("/future-operation")?.({ params: {}, query: {} }, response.res);
      expect(adapter).toHaveBeenCalledTimes(engine === "chromium" ? 1 : 0);
      expect(response.statusCode).toBe(engine === "chromium" ? 200 : 501);
    }
  });
});
