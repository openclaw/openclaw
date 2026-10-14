/**
 * Browser mutation CSRF guard.
 *
 * Blocks browser-control mutation requests from browser-like cross-site
 * contexts while allowing CLI, Gateway, and local service clients.
 */
import type { NextFunction, Request, Response } from "express";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { firstHeader } from "./http-auth.js";

function isMutatingMethod(method: string): boolean {
  const m = (method || "").trim().toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function isLoopbackUrl(value: string): boolean {
  return isLoopbackHost(URL.parse(value.trim())?.hostname ?? "");
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
  return source ? !isLoopbackUrl(source) : false;
}

/** Create middleware that rejects unsafe browser-control mutations. */
export function browserMutationGuardMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, res: Response, next: NextFunction) => {
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
  };
}
