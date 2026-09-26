// Browser tests cover dispatcher path normalization.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";

let createBrowserRouteDispatcher: typeof import("./dispatcher.js").createBrowserRouteDispatcher;

describe("browser route dispatcher path normalization", () => {
  beforeAll(async () => {
    vi.doMock("./index.js", () => {
      return {
        registerBrowserRoutes(app: { get: (path: string, handler: unknown) => void }) {
          app.get("/snapshot", (_: unknown, res: { json: (body: unknown) => void }) => {
            res.json({ route: "snapshot" });
          });
        },
      };
    });
    ({ createBrowserRouteDispatcher } = await import("./dispatcher.js"));
  });

  it("normalizes dispatch paths like browser proxy requests", async () => {
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);
    const result = await dispatcher.dispatch({ method: "GET", path: "  snapshot///  " });
    expect(result).toEqual({ status: 200, body: { route: "snapshot" } });
  });
});
