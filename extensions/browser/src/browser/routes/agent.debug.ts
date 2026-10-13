import crypto from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_TRACE_DIR } from "../paths.js";
import type { BrowserRouteContext } from "../server-context.js";
import { createPlaywrightRouteRegistrar } from "./agent.playwright.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { toBoolean, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  const register = createPlaywrightRouteRegistrar(app, ctx, "inspection");

  register("get", "/console", "console messages", (input) => {
    const level = normalizeOptionalString(typeof input.level === "string" ? input.level : "");
    return async (pw, { cdpUrl, targetId }) => ({
      messages: await pw.getConsoleMessagesViaPlaywright({ cdpUrl, targetId, level }),
    });
  });

  register(
    "get",
    "/errors",
    "page errors",
    (input) => {
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getPageErrorsViaPlaywright({ cdpUrl, targetId, clear });
    },
    EXISTING_SESSION_LIMITS.errors,
  );

  register(
    "get",
    "/requests",
    "network requests",
    (input) => {
      const filter = normalizeOptionalString(typeof input.filter === "string" ? input.filter : "");
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getNetworkRequestsViaPlaywright({ cdpUrl, targetId, filter, clear });
    },
    EXISTING_SESSION_LIMITS.requests,
  );

  register(
    "get",
    "/text",
    "page text",
    (input) => {
      const selector = normalizeOptionalString(input.selector);
      const maxChars = readRoutePositiveInteger(input.maxChars, "maxChars");
      return (pw, target, signal) =>
        pw.getPageTextViaPlaywright({ ...target, signal, selector, maxChars });
    },
    EXISTING_SESSION_LIMITS.text,
  );

  register("get", "/dialogs", "dialog state", () => async (pw, { cdpUrl, targetId }) => ({
    browserState: await pw.getObservedBrowserStateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: ctx.state().resolved.ssrfPolicy,
    }),
  }));

  register("post", "/trace/start", "trace start", (input) => {
    const screenshots = toBoolean(input.screenshots) ?? undefined;
    const snapshots = toBoolean(input.snapshots) ?? undefined;
    const sources = toBoolean(input.sources) ?? undefined;
    return async (pw, { cdpUrl, targetId }) => {
      await pw.traceStartViaPlaywright({ cdpUrl, targetId, screenshots, snapshots, sources });
      return {};
    };
  });

  register("post", "/trace/stop", "trace stop", (input, _params, res) => {
    const requestedPath = toStringOrEmpty(input.path);
    return async (pw, { cdpUrl, targetId }) => {
      const tracePath = await resolveWritableOutputPathOrRespond({
        res,
        rootDir: DEFAULT_TRACE_DIR,
        requestedPath,
        scopeLabel: "trace directory",
        defaultFileName: `browser-trace-${crypto.randomUUID()}.zip`,
        ensureRootDir: true,
      });
      if (!tracePath) {
        return null;
      }
      return { path: await pw.traceStopViaPlaywright({ cdpUrl, targetId, path: tracePath }) };
    };
  });
}
