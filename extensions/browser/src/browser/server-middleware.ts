import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserControlAuth } from "./control-auth.js";
import { firstHeader, isAuthorizedBrowserRequest } from "./http-auth.js";

const authenticatedRequests = new WeakSet<Request>();

function isMutatingMethod(method: string): boolean {
  const m = (method || "").trim().toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/** Return true when a request should be rejected as browser-originated CSRF. */
function shouldRejectBrowserMutation(params: {
  method: string;
  origin?: string;
  referer?: string;
  secFetchSite?: string;
}): boolean {
  if (!isMutatingMethod(params.method)) {
    return false;
  }

  // Strong signal when present: browser says this is cross-site.
  // Avoid being overly clever with "same-site" since localhost vs 127.0.0.1 may differ.
  const secFetchSite = normalizeLowercaseStringOrEmpty(params.secFetchSite);
  if (secFetchSite === "cross-site") {
    return true;
  }

  // Non-browser clients (curl/undici/Node) typically send no Origin/Referer.
  const source = (params.origin ?? "").trim() || (params.referer ?? "").trim();
  return source ? !isLoopbackHost(URL.parse(source.trim())?.hostname ?? "") : false;
}

/** Reject browser-control mutation requests from unsafe cross-site contexts. */
function browserMutationGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (
    shouldRejectBrowserMutation({
      method: req.method,
      origin: firstHeader(req.headers.origin),
      referer: firstHeader(req.headers.referer),
      secFetchSite: firstHeader(req.headers["sec-fetch-site"]),
    })
  ) {
    res.status(403).send("Forbidden");
    return;
  }

  next();
}

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
  app.use(browserMutationGuardMiddleware);
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
