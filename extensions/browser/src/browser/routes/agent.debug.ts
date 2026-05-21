import crypto from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listChromeMcpConsoleMessages,
  listChromeMcpNetworkRequests,
} from "../chrome-mcp.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  requirePwAi,
  withRouteTabContext,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { DEFAULT_TRACE_DIR } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, toBoolean, toStringOrEmpty } from "./utils.js";

function consolePriority(level: string | undefined) {
  switch (level) {
    case "error":
      return 3;
    case "warning":
    case "warn":
      return 2;
    case "info":
    case "log":
      return 1;
    case "debug":
      return 0;
    default:
      return 1;
  }
}

function filterConsoleMessagesByMinimumLevel<
  T extends { type?: string },
>(messages: T[], level: string | undefined): T[] {
  if (!level) {
    return messages;
  }
  const min = consolePriority(level);
  return messages.filter((message) => consolePriority(message.type) >= min);
}

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get(
    "/console",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const level = typeof req.query.level === "string" ? req.query.level : "";

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, profileCtx, resolveTabUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const result = await listChromeMcpConsoleMessages({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              includePreservedMessages: true,
            });
            const messages = filterConsoleMessagesByMinimumLevel(
              result.messages,
              normalizeOptionalString(level),
            );
            const url = await resolveTabUrl(tab.url);
            res.json({
              ok: true,
              messages,
              ...(result.pagination ? { pagination: result.pagination } : {}),
              targetId: tab.targetId,
              ...(url ? { url } : {}),
            });
            return;
          }
          const pw = await requirePwAi(res, "console messages");
          if (!pw) {
            return;
          }
          const messages = await pw.getConsoleMessagesViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            level: normalizeOptionalString(level),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, messages, targetId: tab.targetId, ...(url ? { url } : {}) });
        },
      });
    }),
  );

  app.get(
    "/errors",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const clear = toBoolean(req.query.clear) ?? false;

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "page errors",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
          const result = await pw.getPageErrorsViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            clear,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    }),
  );

  app.get(
    "/requests",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const filter = typeof req.query.filter === "string" ? req.query.filter : "";
      const clear = toBoolean(req.query.clear) ?? false;

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, profileCtx, resolveTabUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const result = await listChromeMcpNetworkRequests({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              includePreservedRequests: true,
            });
            const filterText = normalizeOptionalString(filter);
            const requests = filterText
              ? result.requests.filter((request) => request.url?.includes(filterText))
              : result.requests;
            const url = await resolveTabUrl(tab.url);
            res.json({
              ok: true,
              targetId: tab.targetId,
              ...(url ? { url } : {}),
              requests,
              ...(result.pagination ? { pagination: result.pagination } : {}),
              ...(clear ? { clearUnsupported: true } : {}),
            });
            return;
          }
          const pw = await requirePwAi(res, "network requests");
          if (!pw) {
            return;
          }
          const result = await pw.getNetworkRequestsViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            filter: normalizeOptionalString(filter),
            clear,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    }),
  );

  app.get(
    "/dialogs",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "dialog state",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
          const browserState = await pw.getObservedBrowserStateViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ssrfPolicy: ctx.state().resolved.ssrfPolicy,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), browserState });
        },
      });
    }),
  );

  app.post(
    "/trace/start",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const screenshots = toBoolean(body.screenshots) ?? undefined;
      const snapshots = toBoolean(body.snapshots) ?? undefined;
      const sources = toBoolean(body.sources) ?? undefined;

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "trace start",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
          await pw.traceStartViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            screenshots,
            snapshots,
            sources,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}) });
        },
      });
    }),
  );

  app.post(
    "/trace/stop",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const out = toStringOrEmpty(body.path) || "";

      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "trace stop",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
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
            return;
          }
          await pw.traceStopViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            path: tracePath,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            path: path.resolve(tracePath),
          });
        },
      });
    }),
  );
}
