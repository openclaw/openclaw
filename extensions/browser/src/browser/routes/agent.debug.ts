/**
 * Browser debug and trace routes.
 *
 * Exposes console messages, page errors, network requests, dialog state, and
 * Playwright tracing scoped to the selected browser tab.
 */
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
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

async function sendPlaywrightDebugResult(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  existingSessionUnsupported?: string;
  collect: (ctx: {
    cdpUrl: string;
    targetId: string;
    pw: PwAiModule;
    signal: AbortSignal;
  }) => Promise<object | null>;
}): Promise<void> {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  if (
    params.existingSessionUnsupported &&
    getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp
  ) {
    return jsonError(params.res, 501, params.existingSessionUnsupported);
  }
  await withPlaywrightRouteContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    profileCtx,
    targetId: params.targetId,
    feature: params.feature,
    enforceCurrentUrlAllowed: true,
    run: async ({ cdpUrl, tab, pw, resolveTabUrl, signal }) => {
      const result = await params.collect({ cdpUrl, targetId: tab.targetId, pw, signal });
      if (result === null) {
        return;
      }
      const url = await resolveTabUrl(tab.url);
      params.res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
    },
  });
}

/** Register browser debug endpoints on the control server. */
export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get("/console", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    const level = typeof req.query.level === "string" ? req.query.level : "";

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "console messages",
      collect: async ({ cdpUrl, targetId: resolvedTargetId, pw }) => {
        const messages = await pw.getConsoleMessagesViaPlaywright({
          cdpUrl,
          targetId: resolvedTargetId,
          level: normalizeOptionalString(level),
        });
        return { messages };
      },
    });
  });

  app.get("/errors", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    const clear = toBoolean(req.query.clear) ?? false;

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "page errors",
      existingSessionUnsupported: EXISTING_SESSION_LIMITS.errors,
      collect: async ({ cdpUrl, targetId: targetIdValue, pw }) =>
        await pw.getPageErrorsViaPlaywright({
          cdpUrl,
          targetId: targetIdValue,
          clear,
        }),
    });
  });

  app.get("/requests", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const clear = toBoolean(req.query.clear) ?? false;

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "network requests",
      existingSessionUnsupported: EXISTING_SESSION_LIMITS.requests,
      collect: async ({ cdpUrl, targetId: targetIdLocal, pw }) =>
        await pw.getNetworkRequestsViaPlaywright({
          cdpUrl,
          targetId: targetIdLocal,
          filter: normalizeOptionalString(filter),
          clear,
        }),
    });
  });

  app.get("/text", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);
    const selector = normalizeOptionalString(req.query.selector);
    let maxChars: number | undefined;
    try {
      maxChars = readRoutePositiveInteger(req.query.maxChars, "maxChars");
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }
    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "page text",
      existingSessionUnsupported: EXISTING_SESSION_LIMITS.text,
      collect: async ({ cdpUrl, targetId: textTargetId, pw, signal }) =>
        await pw.getPageTextViaPlaywright({
          cdpUrl,
          targetId: textTargetId,
          selector,
          maxChars,
          signal,
        }),
    });
  });

  app.get("/dialogs", async (req, res) => {
    const targetId = normalizeOptionalString(req.query.targetId);

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "dialog state",
      collect: async ({ cdpUrl, targetId: resolvedTargetId, pw }) => {
        const browserState = await pw.getObservedBrowserStateViaPlaywright({
          cdpUrl,
          targetId: resolvedTargetId,
          ssrfPolicy: ctx.state().resolved.ssrfPolicy,
        });
        return { browserState };
      },
    });
  });

  app.post("/trace/start", async (req, res) => {
    const body = readBody(req);
    const targetId = normalizeOptionalString(body.targetId);
    const screenshots = toBoolean(body.screenshots) ?? undefined;
    const snapshots = toBoolean(body.snapshots) ?? undefined;
    const sources = toBoolean(body.sources) ?? undefined;

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "trace start",
      collect: async ({ cdpUrl, targetId: resolvedTargetId, pw }) => {
        await pw.traceStartViaPlaywright({
          cdpUrl,
          targetId: resolvedTargetId,
          screenshots,
          snapshots,
          sources,
        });
        return {};
      },
    });
  });

  app.post("/trace/stop", async (req, res) => {
    const body = readBody(req);
    const targetId = normalizeOptionalString(body.targetId);
    const out = toStringOrEmpty(body.path) || "";

    await sendPlaywrightDebugResult({
      req,
      res,
      ctx,
      targetId,
      feature: "trace stop",
      collect: async ({ cdpUrl, targetId: resolvedTargetId, pw }) => {
        const id = crypto.randomUUID();
        const tracePath = await resolveWritableOutputPathOrRespond({
          res,
          rootDir: DEFAULT_TRACE_DIR,
          requestedPath: out,
          scopeLabel: "trace directory",
          defaultFileName: `browser-trace-${id}.zip`,
          ensureRootDir: true,
        });
        if (!tracePath) {
          return null;
        }
        const committedTracePath = await pw.traceStopViaPlaywright({
          cdpUrl,
          targetId: resolvedTargetId,
          path: tracePath,
        });
        return { path: committedTracePath };
      },
    });
  });
}
