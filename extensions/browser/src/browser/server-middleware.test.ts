import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
let server: http.Server | undefined;

async function startMiddlewareTestServer() {
  const app = express();
  let routeCalls = 0;
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, { token: "test-token" });
  app.post("/mutate", (req, res) => {
    routeCalls += 1;
    res.status(200).json({ body: req.body });
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }
  return { url: `http://127.0.0.1:${address.port}/mutate`, getRouteCalls: () => routeCalls };
}

afterEach(async () => {
  await server?.[Symbol.asyncDispose]();
  server = undefined;
});

describe("installBrowserCommonMiddleware", () => {
  it("shadows native request signals with the browser response-lifetime signal", () => {
    const middleware: Middleware[] = [];
    const app = {
      use: (...handlers: Middleware[]) => {
        middleware.push(...handlers);
        return app;
      },
    } as unknown as Express;
    installBrowserCommonMiddleware(app);
    const nativeController = new AbortController();
    const req = new EventEmitter() as EventEmitter & Request;
    const requestPrototype = Object.create(Object.getPrototypeOf(req)) as object;
    Object.defineProperty(requestPrototype, "signal", {
      configurable: true,
      get: () => nativeController.signal,
    });
    Object.setPrototypeOf(req, requestPrototype);
    const res = new EventEmitter() as EventEmitter & Response;
    Object.defineProperty(res, "writableEnded", { value: false, writable: true });
    const next = vi.fn();
    const commonMiddleware = middleware[0];
    if (!commonMiddleware) {
      throw new Error("browser common middleware was not installed");
    }
    commonMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(Object.hasOwn(req, "signal")).toBe(true);
    expect(req.signal).not.toBe(nativeController.signal);
    expect(req.signal.aborted).toBe(false);
    req.emit("aborted");
    expect([req.signal.aborted, req.signal.reason]).toEqual([true, new Error("request aborted")]);
  });

  it.each([true, false])("guards JSON mutations (cross-site=%s)", async (crossSite) => {
    const { url, getRouteCalls } = await startMiddlewareTestServer();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(crossSite
          ? { origin: "https://evil.example" }
          : { authorization: "Bearer test-token" }),
      },
      body: crossSite ? "{not json" : JSON.stringify({ ok: true }),
    });
    expect({
      status: response.status,
      body: crossSite ? await response.text() : await response.json(),
      routeCalls: getRouteCalls(),
    }).toEqual(
      crossSite
        ? { status: 403, body: "Forbidden", routeCalls: 0 }
        : { status: 200, body: { body: { ok: true } }, routeCalls: 1 },
    );
  });
});
