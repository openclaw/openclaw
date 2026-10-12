import type { Express, Request } from "express";
import express from "express";
import type { BrowserControlAuth } from "./control-auth.js";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

const authenticatedRequests = new WeakSet<Request>();

export function hasVerifiedBrowserAuth(req: Request): boolean {
  return authenticatedRequests.has(req);
}

export function installBrowserCommonMiddleware(app: Express) {
  app.use((req, res, next) => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(new Error("request aborted"));
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) {
        abort();
      }
    });
    // Node 24.16+'s native request signal aborts when a POST body finishes.
    // Browser work follows the client/response lifetime instead.
    Object.defineProperty(req, "signal", {
      value: ctrl.signal,
      configurable: true,
    });
    next();
  });
  app.use(browserMutationGuardMiddleware());
  app.use(express.json({ limit: "1mb" }));
}

export function installBrowserAuthMiddleware(app: Express, auth: BrowserControlAuth) {
  if (!auth.token && !auth.password) {
    return;
  }
  app.use((req, res, next) => {
    if (isAuthorizedBrowserRequest(req, auth)) {
      authenticatedRequests.add(req);
      return next();
    }
    res.status(401).send("Unauthorized");
  });
}
