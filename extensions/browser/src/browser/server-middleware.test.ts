import { EventEmitter } from "node:events";
import type { Express, NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { installBrowserCommonMiddleware } from "./server-middleware.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

describe("installBrowserCommonMiddleware", () => {
  it("shadows native request signals with the browser response-lifetime signal", () => {
    const middleware: Middleware[] = [];
    const app = {
      use: vi.fn((...handlers: unknown[]) => {
        for (const handler of handlers) {
          if (typeof handler === "function") {
            middleware.push(handler as Middleware);
          }
        }
        return app;
      }),
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
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toEqual(new Error("request aborted"));
  });
});
