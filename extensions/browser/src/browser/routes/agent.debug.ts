import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_TRACE_DIR } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import { readBody, resolveProfileContext, withPlaywrightRouteContext } from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

type DebugCollector = (
  pw: PwAiModule,
  target: { cdpUrl: string; targetId: string; signal: AbortSignal },
) => Promise<object | null>;

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  const register = (
    method: "get" | "post",
    path: string,
    feature: string,
    prepare: (input: Record<string, unknown>, res: BrowserResponse) => DebugCollector,
    existingSessionUnsupported?: string,
  ) => {
    app[method](path, async (req, res) => {
      const input = method === "get" ? req.query : readBody(req);
      const targetId = normalizeOptionalString(input.targetId);
      let collect: DebugCollector;
      try {
        collect = prepare(input, res);
      } catch (error) {
        return jsonError(res, 400, formatErrorMessage(error));
      }
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      if (
        existingSessionUnsupported &&
        getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp
      ) {
        return jsonError(res, 501, existingSessionUnsupported);
      }
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        profileCtx,
        targetId,
        feature,
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw, resolveTabUrl, signal }) => {
          const result = await collect(pw, { cdpUrl, targetId: tab.targetId, signal });
          if (result === null) {
            return;
          }
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    });
  };

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
      return (pw, target) => pw.getPageTextViaPlaywright({ ...target, selector, maxChars });
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

  register("post", "/trace/stop", "trace stop", (input, res) => {
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
