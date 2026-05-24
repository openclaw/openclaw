/**
 * Browser debug and trace routes.
 *
 * Exposes console messages, page errors, network requests, dialog state, and
 * Playwright tracing scoped to the selected browser tab.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  analyzeChromeMcpPerformanceInsight,
  executeChromeMcpThirdPartyDeveloperTool,
  executeChromeMcpWebMcpTool,
  getChromeMcpConsoleMessage,
  getChromeMcpHeapSnapshotClassNodes,
  getChromeMcpHeapSnapshotDetails,
  getChromeMcpHeapSnapshotRetainers,
  getChromeMcpHeapSnapshotSummary,
  getChromeMcpNetworkRequest,
  getChromeMcpTabId,
  installChromeMcpExtension,
  listChromeMcpExtensions,
  listChromeMcpConsoleMessages,
  listChromeMcpNetworkRequests,
  listChromeMcpThirdPartyDeveloperTools,
  listChromeMcpWebMcpTools,
  reloadChromeMcpExtension,
  runChromeMcpLighthouseAudit,
  startChromeMcpPerformanceTrace,
  startChromeMcpScreencast,
  stopChromeMcpPerformanceTrace,
  stopChromeMcpScreencast,
  takeChromeMcpHeapSnapshot,
  triggerChromeMcpExtensionAction,
  uninstallChromeMcpExtension,
} from "../chrome-mcp.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  requirePwAi,
  withRouteTabContext,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import {
  resolveExistingOutputFilePathOrRespond,
  resolveOutputDirectoryPathOrRespond,
  resolveWritableOutputPathOrRespond,
} from "./output-paths.js";
import { DEFAULT_TRACE_DIR } from "./path-output.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

function browserDebugTargetPayload(
  targetId: string,
  url?: string,
): { ok: true; targetId: string; url?: string } {
  return { ok: true, targetId, ...(url ? { url } : {}) };
}

async function sendPlaywrightDebugCollection(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  collect: (ctx: { cdpUrl: string; targetId: string; pw: PwAiModule }) => Promise<object>;
}): Promise<void> {
  await withPlaywrightRouteContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    targetId: params.targetId,
    feature: params.feature,
    enforceCurrentUrlAllowed: true,
    run: async ({ cdpUrl, tab, pw, resolveTabUrl }) => {
      const result = await params.collect({ cdpUrl, targetId: tab.targetId, pw });
      const url = await resolveTabUrl(tab.url);
      params.res.json({ ...browserDebugTargetPayload(tab.targetId, url), ...result });
    },
  });
}

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

function filterConsoleMessagesByMinimumLevel<T extends { type?: string }>(
  messages: T[],
  level: string | undefined,
): T[] {
  if (!level) {
    return messages;
  }
  const min = consolePriority(level);
  return messages.filter((message) => consolePriority(message.type) >= min);
}

function requireChromeMcpProfile(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  profileCtx: { profile: unknown },
) {
  if (!getBrowserProfileCapabilities(profileCtx.profile as never).usesChromeMcp) {
    jsonError(res as never, 400, "this route is only supported for Chrome MCP profiles");
    return false;
  }
  return true;
}

const activeScreencasts = new Map<string, string>();

function screencastKey(profileName: string, targetId: string): string {
  return `${profileName}:${targetId}`;
}

function defaultScreencastFileName(): string {
  return `browser-screencast-${crypto.randomUUID()}.webm`;
}

async function resolveHeapSnapshotReadPathOrRespond(
  res: Parameters<typeof resolveExistingOutputFilePathOrRespond>[0]["res"],
  requestedPath: string,
): Promise<string | null> {
  return resolveExistingOutputFilePathOrRespond({
    res,
    rootDir: DEFAULT_TRACE_DIR,
    requestedPath,
    scopeLabel: "heap snapshot file",
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectScreencastArtifact(filePath: string | undefined): Promise<{
  filePath?: string;
  artifactExists?: boolean;
  artifactBytes?: number;
  artifactReady?: boolean;
  artifactWarning?: string;
}> {
  if (!filePath) {
    return {};
  }
  let observed = false;
  let lastBytes = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const stat = await fs.stat(filePath);
      observed = true;
      lastBytes = stat.size;
      if (stat.size > 0) {
        return { filePath, artifactExists: true, artifactBytes: stat.size, artifactReady: true };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          filePath,
          artifactExists: false,
          artifactReady: false,
          artifactWarning: String((error as Error).message || error),
        };
      }
    }
    await sleep(200);
  }
  return {
    filePath,
    artifactExists: observed,
    artifactBytes: observed ? lastBytes : undefined,
    artifactReady: false,
    artifactWarning: observed
      ? "screencast artifact exists but is empty after waiting for encoder flush"
      : "screencast artifact was not observed after waiting for encoder flush",
  };
}

function isChromeExtensionsUnavailableError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return message.includes("Extensions.getExtensions") && message.includes("Method not available");
}

function parseMode(value: unknown): "navigation" | "snapshot" | undefined {
  return value === "navigation" || value === "snapshot" ? value : undefined;
}

function parseDevice(value: unknown): "desktop" | "mobile" | undefined {
  return value === "desktop" || value === "mobile" ? value : undefined;
}

/** Register browser debug endpoints on the control server. */
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
          res.json({ ...browserDebugTargetPayload(tab.targetId, url), messages });
        },
      });
    }),
  );

  app.get(
    "/errors",
    asyncBrowserRoute(async (req, res) => {
      const targetId = resolveTargetIdFromQuery(req.query);
      const clear = toBoolean(req.query.clear) ?? false;

      await sendPlaywrightDebugCollection({
        req,
        res,
        ctx,
        targetId,
        feature: "page errors",
        collect: async ({ cdpUrl, targetId: targetIdValue, pw }) =>
          await pw.getPageErrorsViaPlaywright({
            cdpUrl,
            targetId: targetIdValue,
            clear,
          }),
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
          res.json({ ...browserDebugTargetPayload(tab.targetId, url), ...result });
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
          res.json({ ...browserDebugTargetPayload(tab.targetId, url), browserState });
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

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, profileCtx, resolveTabUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const output = await startChromeMcpPerformanceTrace({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              reload: false,
              autoStop: false,
            });
            const url = await resolveTabUrl(tab.url);
            res.json({
              ok: true,
              targetId: tab.targetId,
              ...(url ? { url } : {}),
              traceFormat: "chrome-devtools",
              ...(screenshots || snapshots || sources
                ? { unsupportedPlaywrightTraceOptions: true }
                : {}),
              ...(output ? { output } : {}),
            });
            return;
          }
          const pw = await requirePwAi(res, "trace start");
          if (!pw) {
            return;
          }
          await pw.traceStartViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            screenshots,
            snapshots,
            sources,
          });
          const url = await resolveTabUrl(tab.url);
          res.json(browserDebugTargetPayload(tab.targetId, url));
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

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, profileCtx, resolveTabUrl }) => {
          const usesChromeMcp = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
          const id = crypto.randomUUID();
          const tracePath = await resolveWritableOutputPathOrRespond({
            res,
            rootDir: DEFAULT_TRACE_DIR,
            requestedPath: out,
            scopeLabel: "trace directory",
            defaultFileName: usesChromeMcp
              ? `browser-trace-${id}.json.gz`
              : `browser-trace-${id}.zip`,
            ensureRootDir: true,
          });
          if (!tracePath) {
            return;
          }
          if (usesChromeMcp) {
            const output = await stopChromeMcpPerformanceTrace({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              filePath: tracePath,
            });
            const url = await resolveTabUrl(tab.url);
            res.json({
              ok: true,
              targetId: tab.targetId,
              ...(url ? { url } : {}),
              path: path.resolve(tracePath),
              traceFormat: "chrome-devtools",
              ...(output ? { output } : {}),
            });
            return;
          }
          const pw = await requirePwAi(res, "trace stop");
          if (!pw) {
            return;
          }
          await pw.traceStopViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            path: tracePath,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ...browserDebugTargetPayload(tab.targetId, url),
            path: path.resolve(tracePath),
          });
        },
      });
    }),
  );

  app.post(
    "/trace/insight",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const insightSetId = toStringOrEmpty(body.insightSetId) || "navigation-1";
      const insightName = toStringOrEmpty(body.insightName) || "DocumentLatency";

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            return jsonError(
              res,
              400,
              "trace insight analysis is only supported for Chrome MCP profiles",
            );
          }
          const output = await analyzeChromeMcpPerformanceInsight({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            insightSetId,
            insightName,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            traceFormat: "chrome-devtools",
            insightSetId,
            insightName,
            ...(output ? { output } : {}),
          });
        },
      });
    }),
  );

  app.post(
    "/heap-snapshot/take",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = resolveTargetIdFromBody(body);
      const out = toStringOrEmpty(body.path) || "";

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const id = crypto.randomUUID();
          const heapSnapshotPath = await resolveWritableOutputPathOrRespond({
            res,
            rootDir: DEFAULT_TRACE_DIR,
            requestedPath: out,
            scopeLabel: "heap snapshot directory",
            defaultFileName: `browser-heapsnapshot-${id}.heapsnapshot`,
            ensureRootDir: true,
          });
          if (!heapSnapshotPath) {
            return;
          }
          const output = await takeChromeMcpHeapSnapshot({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            filePath: heapSnapshotPath,
            timeoutMs: toNumber(body.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            path: path.resolve(heapSnapshotPath),
            ...(output ? { output } : {}),
          });
        },
      });
    }),
  );

  app.post(
    "/heap-snapshot/summary",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const filePath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
      if (!filePath) {
        return jsonError(res, 400, "path is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const heapSnapshotPath = await resolveHeapSnapshotReadPathOrRespond(res, filePath);
          if (!heapSnapshotPath) {
            return;
          }
          const result = await getChromeMcpHeapSnapshotSummary({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            filePath: heapSnapshotPath,
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, path: heapSnapshotPath, ...result });
        },
      });
    }),
  );

  app.post(
    "/heap-snapshot/details",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const filePath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
      if (!filePath) {
        return jsonError(res, 400, "path is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const heapSnapshotPath = await resolveHeapSnapshotReadPathOrRespond(res, filePath);
          if (!heapSnapshotPath) {
            return;
          }
          const result = await getChromeMcpHeapSnapshotDetails({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            filePath: heapSnapshotPath,
            pageIdx: toNumber(body.pageIdx),
            pageSize: toNumber(body.pageSize),
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, path: heapSnapshotPath, ...result });
        },
      });
    }),
  );

  app.post(
    "/heap-snapshot/class-nodes",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const filePath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
      const id = toNumber(body.id);
      if (!filePath) {
        return jsonError(res, 400, "path is required");
      }
      if (id === undefined) {
        return jsonError(res, 400, "id is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const heapSnapshotPath = await resolveHeapSnapshotReadPathOrRespond(res, filePath);
          if (!heapSnapshotPath) {
            return;
          }
          const result = await getChromeMcpHeapSnapshotClassNodes({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            filePath: heapSnapshotPath,
            id,
            pageIdx: toNumber(body.pageIdx),
            pageSize: toNumber(body.pageSize),
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, path: heapSnapshotPath, id, ...result });
        },
      });
    }),
  );

  app.post(
    "/heap-snapshot/retainers",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const filePath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
      const nodeId = toNumber(body.nodeId);
      if (!filePath) {
        return jsonError(res, 400, "path is required");
      }
      if (nodeId === undefined) {
        return jsonError(res, 400, "nodeId is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const heapSnapshotPath = await resolveHeapSnapshotReadPathOrRespond(res, filePath);
          if (!heapSnapshotPath) {
            return;
          }
          const result = await getChromeMcpHeapSnapshotRetainers({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            filePath: heapSnapshotPath,
            nodeId,
            pageIdx: toNumber(body.pageIdx),
            pageSize: toNumber(body.pageSize),
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, path: heapSnapshotPath, nodeId, ...result });
        },
      });
    }),
  );

  app.post(
    "/lighthouse",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const requestedOutputDir = toStringOrEmpty(body.outputDirPath);
          let outputDirPath: string | undefined;
          if (requestedOutputDir) {
            const resolvedOutputDir = await resolveOutputDirectoryPathOrRespond({
              res,
              rootDir: DEFAULT_TRACE_DIR,
              requestedPath: requestedOutputDir,
              scopeLabel: "lighthouse output directory",
              ensureRootDir: true,
            });
            if (!resolvedOutputDir) {
              return;
            }
            outputDirPath = resolvedOutputDir;
          }
          const result = await runChromeMcpLighthouseAudit({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            mode: parseMode(body.mode),
            device: parseDevice(body.device),
            outputDirPath,
            timeoutMs: toNumber(body.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    }),
  );

  app.post(
    "/screencast/start",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const requestedPath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
          const filePath = await resolveWritableOutputPathOrRespond({
            res,
            rootDir: DEFAULT_TRACE_DIR,
            requestedPath,
            scopeLabel: "screencast directory",
            defaultFileName: defaultScreencastFileName(),
            ensureRootDir: true,
          });
          if (!filePath) {
            return;
          }
          const output = await startChromeMcpScreencast({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            filePath,
            timeoutMs: toNumber(body.timeoutMs),
          });
          activeScreencasts.set(screencastKey(profileCtx.profile.name, tab.targetId), filePath);
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), filePath, output });
        },
      });
    }),
  );

  app.post(
    "/screencast/stop",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const requestedPath = toStringOrEmpty(body.path) || toStringOrEmpty(body.filePath);
          let filePath: string | undefined;
          if (requestedPath) {
            const resolvedPath = await resolveWritableOutputPathOrRespond({
              res,
              rootDir: DEFAULT_TRACE_DIR,
              requestedPath,
              scopeLabel: "screencast directory",
              ensureRootDir: true,
            });
            if (!resolvedPath) {
              return;
            }
            filePath = resolvedPath;
          }
          const output = await stopChromeMcpScreencast({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs: toNumber(body.timeoutMs),
          });
          const key = screencastKey(profileCtx.profile.name, tab.targetId);
          filePath ??= activeScreencasts.get(key);
          activeScreencasts.delete(key);
          const artifact = await inspectScreencastArtifact(filePath);
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            ...artifact,
            output,
          });
        },
      });
    }),
  );

  app.get(
    "/extensions",
    asyncBrowserRoute(async (req, res) => {
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          try {
            const extensions = await listChromeMcpExtensions({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              timeoutMs: toNumber(req.query.timeoutMs),
            });
            res.json({ ok: true, extensions });
          } catch (error) {
            if (!isChromeExtensionsUnavailableError(error)) {
              throw error;
            }
            res.json({
              ok: true,
              extensions: [],
              unavailable: true,
              reason: "Chrome Extensions protocol domain is not available in this browser session",
              error: String((error as Error).message || error),
            });
          }
        },
      });
    }),
  );

  app.post(
    "/extensions/install",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const extensionPath = toStringOrEmpty(body.path);
      if (!extensionPath) {
        return jsonError(res, 400, "path is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const output = await installChromeMcpExtension({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            path: extensionPath,
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, path: extensionPath, output });
        },
      });
    }),
  );

  app.post(
    "/extensions/uninstall",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const id = toStringOrEmpty(body.id);
      if (!id) {
        return jsonError(res, 400, "id is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const output = await uninstallChromeMcpExtension({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            id,
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, id, output });
        },
      });
    }),
  );

  app.post(
    "/extensions/reload",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const id = toStringOrEmpty(body.id);
      if (!id) {
        return jsonError(res, 400, "id is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const output = await reloadChromeMcpExtension({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            id,
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, id, output });
        },
      });
    }),
  );

  app.post(
    "/extensions/action",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const id = toStringOrEmpty(body.id);
      if (!id) {
        return jsonError(res, 400, "id is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        run: async ({ profileCtx }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const output = await triggerChromeMcpExtensionAction({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            id,
            timeoutMs: toNumber(body.timeoutMs),
          });
          res.json({ ok: true, id, output });
        },
      });
    }),
  );

  app.get(
    "/extensions/tab-id",
    asyncBrowserRoute(async (req, res) => {
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const tabId = await getChromeMcpTabId({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs: toNumber(req.query.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), tabId });
        },
      });
    }),
  );

  app.get(
    "/third-party-tools",
    asyncBrowserRoute(async (req, res) => {
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const result = await listChromeMcpThirdPartyDeveloperTools({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs: toNumber(req.query.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    }),
  );

  app.post(
    "/third-party-tools/execute",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const toolName = toStringOrEmpty(body.toolName);
      if (!toolName) {
        return jsonError(res, 400, "toolName is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const result = await executeChromeMcpThirdPartyDeveloperTool({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            toolName,
            paramsJson: toStringOrEmpty(body.paramsJson) || undefined,
            toolParams:
              body.toolParams &&
              typeof body.toolParams === "object" &&
              !Array.isArray(body.toolParams)
                ? (body.toolParams as Record<string, unknown>)
                : undefined,
            timeoutMs: toNumber(body.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            toolName,
            ...result,
          });
        },
      });
    }),
  );

  app.get(
    "/web-mcp-tools",
    asyncBrowserRoute(async (req, res) => {
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const result = await listChromeMcpWebMcpTools({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs: toNumber(req.query.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), ...result });
        },
      });
    }),
  );

  app.post(
    "/web-mcp-tools/execute",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const toolName = toStringOrEmpty(body.toolName);
      if (!toolName) {
        return jsonError(res, 400, "toolName is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromBody(body),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const result = await executeChromeMcpWebMcpTool({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            toolName,
            inputJson: toStringOrEmpty(body.inputJson) || undefined,
            input:
              body.input && typeof body.input === "object" && !Array.isArray(body.input)
                ? (body.input as Record<string, unknown>)
                : undefined,
            timeoutMs: toNumber(body.timeoutMs),
          });
          const url = await resolveTabUrl(tab.url);
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(url ? { url } : {}),
            toolName,
            ...result,
          });
        },
      });
    }),
  );

  app.get(
    "/console/message",
    asyncBrowserRoute(async (req, res) => {
      const msgid = toNumber(req.query.msgid);
      if (msgid === undefined) {
        return jsonError(res, 400, "msgid is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const message = await getChromeMcpConsoleMessage({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            msgid,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), msgid, message });
        },
      });
    }),
  );

  app.get(
    "/requests/request",
    asyncBrowserRoute(async (req, res) => {
      const reqid = toNumber(req.query.reqid);
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId: resolveTargetIdFromQuery(req.query),
        enforceCurrentUrlAllowed: true,
        run: async ({ tab, profileCtx, resolveTabUrl }) => {
          if (!requireChromeMcpProfile(res, profileCtx)) {
            return;
          }
          const requestedRequestFilePath = toStringOrEmpty(req.query.requestFilePath);
          const requestedResponseFilePath = toStringOrEmpty(req.query.responseFilePath);
          let requestFilePath: string | undefined;
          let responseFilePath: string | undefined;
          if (requestedRequestFilePath) {
            const resolvedRequestFilePath = await resolveWritableOutputPathOrRespond({
              res,
              rootDir: DEFAULT_TRACE_DIR,
              requestedPath: requestedRequestFilePath,
              scopeLabel: "request detail request body path",
              ensureRootDir: true,
            });
            if (!resolvedRequestFilePath) {
              return;
            }
            requestFilePath = resolvedRequestFilePath;
          }
          if (requestedResponseFilePath) {
            const resolvedResponseFilePath = await resolveWritableOutputPathOrRespond({
              res,
              rootDir: DEFAULT_TRACE_DIR,
              requestedPath: requestedResponseFilePath,
              scopeLabel: "request detail response body path",
              ensureRootDir: true,
            });
            if (!resolvedResponseFilePath) {
              return;
            }
            responseFilePath = resolvedResponseFilePath;
          }
          const request = await getChromeMcpNetworkRequest({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            reqid,
            requestFilePath,
            responseFilePath,
          });
          const url = await resolveTabUrl(tab.url);
          res.json({ ok: true, targetId: tab.targetId, ...(url ? { url } : {}), reqid, request });
        },
      });
    }),
  );
}
