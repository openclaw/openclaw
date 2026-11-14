import { resolveBrowserEngine } from "../engines/registry.js";
import {
  admitBrowserInput,
  BROWSER_OPERATOR_CONTROL_MESSAGE,
  isBrowserInputRoute,
  recordBrowserOperatorInput,
} from "../operator-control.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
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

/**
 * Enforce the selected engine and operator take-over at the shared HTTP/in-process route
 * boundary, so every caller (agent tools, CLI, node proxy, Control UI) meets the same checks.
 */
export function withBrowserProfileCapabilities(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
): BrowserRouteRegistrar {
  const wrap =
    (
      method: "GET" | "POST" | "DELETE",
      path: string,
      handler: Parameters<BrowserRouteRegistrar["get"]>[1],
    ) =>
    async (...args: Parameters<typeof handler>) => {
      const [req, res] = args;
      if (!PROFILE_MANAGEMENT_ROUTES.has(path)) {
        const profileCtx = getProfileContext(req, ctx);
        if ("error" in profileCtx) {
          return jsonError(res, profileCtx.status, profileCtx.error);
        }
        const engine = resolveBrowserEngine(profileCtx.profile.engine);
        const body =
          // SAFETY: The condition admits only non-null objects; kind is narrowed before use.
          req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        if (
          !engine.supportsRequest({
            path,
            actionKind: typeof body.kind === "string" ? body.kind : undefined,
            actionSelector: toStringOrEmpty(body.selector),
            ...(path === "/snapshot"
              ? {
                  snapshot: {
                    labels: toBoolean(req.query.labels) === true,
                    format: toStringOrEmpty(req.query.format),
                    refs: toStringOrEmpty(req.query.refs),
                    selector: toStringOrEmpty(req.query.selector),
                    frame: toStringOrEmpty(req.query.frame),
                  },
                }
              : {}),
          })
        ) {
          res.status(501).json({
            error: `${engine.descriptor.label} does not support this browser operation (${path}). Select a Chromium profile for visual or persistent-browser features.`,
            code: "BROWSER_CAPABILITY_UNSUPPORTED",
            engine: engine.descriptor.id,
          });
          return;
        }
        if (path !== "/control" && isBrowserInputRoute(method, path)) {
          const connId = req.requester?.connId;
          if (!admitBrowserInput(ctx.state(), profileCtx.profile, connId)) {
            return jsonError(res, 409, BROWSER_OPERATOR_CONTROL_MESSAGE);
          }
          if (toBoolean(req.query.operatorInput) === true) {
            recordBrowserOperatorInput(ctx.state(), profileCtx.profile, connId);
          }
        }
      }
      return await handler(...args);
    };
  return {
    get: (path, handler) => app.get(path, wrap("GET", path, handler)),
    post: (path, handler) => app.post(path, wrap("POST", path, handler)),
    delete: (path, handler) => app.delete(path, wrap("DELETE", path, handler)),
  };
}
