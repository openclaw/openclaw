import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { evaluateChromeMcpScript, withChromeMcpDocument } from "../chrome-mcp.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../constants.js";
import { assertBrowserNavigationResultAllowed } from "../navigation-guard.js";
import { DEFAULT_TRACE_DIR } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  browserNavigationPolicyForProfile,
  resolveProfileContext,
  withPlaywrightRouteContext,
  withRouteTabContext,
} from "./agent.shared.js";
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
    collectExistingSession?: (params: {
      input: Record<string, unknown>;
      profileName: string;
      profile: Parameters<typeof evaluateChromeMcpScript>[0]["profile"];
      targetId: string;
      signal: AbortSignal;
      resolveTabUrl: (fallbackUrl?: string) => Promise<string | undefined>;
    }) => Promise<object | null>,
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
        if (!collectExistingSession) {
          return jsonError(res, 501, existingSessionUnsupported);
        }
        await withRouteTabContext({
          req,
          res,
          ctx,
          profileCtx,
          targetId,
          enforceCurrentUrlAllowed: true,
          run: async ({ tab, signal, resolveTabUrl }) => {
            const result = await collectExistingSession({
              input,
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              signal,
              resolveTabUrl,
            });
            if (result === null) {
              return;
            }
            const resultRecord = Object.fromEntries(Object.entries(result));
            const resultUrl =
              typeof resultRecord.url === "string" && resultRecord.url.trim()
                ? resultRecord.url
                : tab.url;
            await assertBrowserNavigationResultAllowed({
              url: resultUrl,
              signal,
              ...browserNavigationPolicyForProfile(ctx, profileCtx),
            });
            res.json({ ok: true, targetId: tab.targetId, url: resultUrl, ...result });
          },
        });
        return;
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
    async ({ input, profileName, profile, targetId, signal }) => {
      const selector = normalizeOptionalString(input.selector);
      const maxChars = Math.min(
        readRoutePositiveInteger(input.maxChars, "maxChars") ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
        DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      );
      const result = await withChromeMcpDocument(
        {
          profileName,
          profile,
          targetId,
          signal,
        },
        (document) =>
          document.evaluate(`(root) => {
          const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
          if (boundDocument !== document) throw new Error("Chrome MCP document changed during page text read");
          const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.querySelector("article") ?? document.querySelector("main") ?? document.body'};
          if (!target) throw new Error("No page text target matched");
          const text = String(target.innerText || "");
          const maxChars = ${maxChars};
          return { url: location.href, text: text.slice(0, maxChars), truncated: text.length > maxChars };
        }`),
      );
      if (!result || typeof result !== "object") {
        throw new Error("Chrome MCP page text returned an invalid result");
      }
      const resultRecord = Object.fromEntries(Object.entries(result));
      const resultUrl = resultRecord.url;
      if (typeof resultUrl !== "string" || !resultUrl.trim()) {
        throw new Error("Chrome MCP page text returned no document URL");
      }
      const rawText = resultRecord.text;
      const text = truncateUtf16Safe(typeof rawText === "string" ? rawText : "", maxChars);
      return { url: resultUrl, text, truncated: Boolean(resultRecord.truncated) };
    },
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
