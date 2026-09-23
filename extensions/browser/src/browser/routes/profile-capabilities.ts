import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar, BrowserRequest } from "./types.js";
import { getProfileContext, jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

const PROFILE_MANAGEMENT_ROUTES = new Set([
  "/profiles",
  "/profiles/create",
  "/profiles/import",
  "/profiles/:name",
  "/system-profiles",
  "/system-profile-import/status",
  "/system-profile-import/dismiss",
]);

// The experimental engine has a deliberately small, verified surface. Unknown
// routes fail closed so future Chromium features are not advertised accidentally.
const SEMANTIC_ROUTES = new Set([
  "/",
  "/doctor",
  "/start",
  "/stop",
  "/tabs",
  "/tabs/open",
  "/tabs/focus",
  "/tabs/:targetId",
  "/tabs/action",
  "/navigate",
  "/text",
  "/snapshot",
  "/act",
]);
const SEMANTIC_ACT_KINDS = new Set([
  "click",
  "type",
  "press",
  "select",
  "fill",
  "wait",
  "evaluate",
  "close",
]);

function unsupportedRequest(path: string, req: BrowserRequest): boolean {
  if (!SEMANTIC_ROUTES.has(path)) {
    return true;
  }
  const body =
    // SAFETY: The condition admits only non-null objects; kind is narrowed before use.
    req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  if (path === "/act") {
    return (
      (typeof body.kind === "string" && !SEMANTIC_ACT_KINDS.has(body.kind)) ||
      Boolean(toStringOrEmpty(body.selector))
    );
  }
  return (
    path === "/snapshot" &&
    (toBoolean(req.query.labels) === true ||
      toStringOrEmpty(req.query.format) === "aria" ||
      toStringOrEmpty(req.query.refs) === "role" ||
      Boolean(toStringOrEmpty(req.query.selector)) ||
      Boolean(toStringOrEmpty(req.query.frame)))
  );
}

/** Enforce the selected engine at the shared HTTP/in-process route boundary. */
export function withBrowserProfileCapabilities(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
): BrowserRouteRegistrar {
  const wrap =
    (path: string, handler: Parameters<BrowserRouteRegistrar["get"]>[1]) =>
    async (...args: Parameters<typeof handler>) => {
      const [req, res] = args;
      if (!PROFILE_MANAGEMENT_ROUTES.has(path)) {
        const profileCtx = getProfileContext(req, ctx);
        if ("error" in profileCtx) {
          return jsonError(res, profileCtx.status, profileCtx.error);
        }
        const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
        if (profileCtx.profile.engine === "lightpanda" && unsupportedRequest(path, req)) {
          res.status(501).json({
            error: `Lightpanda does not support this browser operation (${path}). Select a Chromium profile for visual or persistent-browser features.`,
            code: "BROWSER_CAPABILITY_UNSUPPORTED",
            engine: "lightpanda",
          });
          return;
        }
        // Reading the preset here keeps enforcement tied to the same owner as
        // model-facing capability filtering, rather than the connection URL.
        if (
          path === "/snapshot" &&
          !capabilities.supportsScreenshots &&
          toBoolean(req.query.labels) === true
        ) {
          return jsonError(res, 501, "This browser does not support labeled screenshots.");
        }
      }
      return await handler(...args);
    };
  return {
    get: (path, handler) => app.get(path, wrap(path, handler)),
    post: (path, handler) => app.post(path, wrap(path, handler)),
    delete: (path, handler) => app.delete(path, wrap(path, handler)),
  };
}
