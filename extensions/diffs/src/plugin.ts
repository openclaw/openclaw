import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createAuthRateLimiter, resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import {
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { DIFFS_AGENT_GUIDANCE } from "./prompt-guidance.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffsTool } from "./tool.js";
import {
  DIFF_ARTIFACT_ID_PATTERN,
  DIFF_ARTIFACT_TOKEN_PATTERN,
  type DiffArtifactBlobMetadata,
} from "./types.js";
import { VIEWER_ASSET_PREFIX, VIEWER_RUNTIME_PATH, getServedViewerAsset } from "./viewer-assets.js";

const DIFFS_LANGUAGE_PACK_PLUGIN_ID = "diffs-language-pack";
const DIFF_ARTIFACT_NAMESPACE = "diff-artifacts";
const DIFF_ARTIFACT_MAX_ENTRIES = 2_048;
const DIFF_ARTIFACT_MAX_BYTES_PER_ENTRY = 32 * 1024 * 1024;
const DIFF_ARTIFACT_MAX_BYTES_PER_NAMESPACE = 256 * 1024 * 1024;
const VIEW_PREFIX = "/plugins/diffs/view/";
const VIEWER_MAX_FAILURES_PER_WINDOW = 40;
const VIEWER_FAILURE_WINDOW_MS = 60_000;
const VIEWER_LOCKOUT_MS = 60_000;
const VIEWER_LIMITER_MAX_KEYS = 2_048;
const VIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function registerDiffsPlugin(api: OpenClawPluginApi): void {
  // CLI metadata has no runtime state, and this plugin exposes no CLI commands.
  if (api.registrationMode === "cli-metadata") {
    return;
  }

  const store = new DiffArtifactStore({
    rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
    blobStore: api.runtime.state.openBlobStore<DiffArtifactBlobMetadata>({
      namespace: DIFF_ARTIFACT_NAMESPACE,
      maxEntries: DIFF_ARTIFACT_MAX_ENTRIES,
      maxBytesPerEntry: DIFF_ARTIFACT_MAX_BYTES_PER_ENTRY,
      maxBytesPerNamespace: DIFF_ARTIFACT_MAX_BYTES_PER_NAMESPACE,
      overflowPolicy: "reject-new",
    }),
    logger: api.logger,
  });
  api.registerService({
    id: "diffs-artifact-cleanup",
    start: () => store.startCleanup(),
    stop: () => store.stopCleanup(),
  });
  const resolveCurrentPluginConfig = () =>
    resolveLivePluginConfigObject(
      () => api.runtime.config.current() as OpenClawConfig,
      "diffs",
      api.pluginConfig as Record<string, unknown>,
    ) ?? {};
  api.registerTool(
    (ctx) => {
      const pluginConfig = resolveCurrentPluginConfig();
      return createDiffsTool({
        getConfig: () =>
          (ctx.getRuntimeConfig?.() ??
            ctx.runtimeConfig ??
            ctx.config ??
            api.runtime.config.current()) as OpenClawConfig, // SAFETY: The tool only reads this immutable runtime snapshot.
        store,
        defaults: resolveDiffsPluginDefaults(pluginConfig),
        viewerBaseUrl: resolveDiffsPluginViewerBaseUrl(pluginConfig),
        languagePackAvailable: resolveDiffsLanguagePackAvailability(api),
        context: ctx,
      });
    },
    {
      name: "diffs",
    },
  );
  const viewerFailureLimiter = createAuthRateLimiter({
    maxAttempts: VIEWER_MAX_FAILURES_PER_WINDOW,
    windowMs: VIEWER_FAILURE_WINDOW_MS,
    lockoutMs: VIEWER_LOCKOUT_MS,
    exemptLoopback: false,
    pruneIntervalMs: 0,
    maxEntries: VIEWER_LIMITER_MAX_KEYS,
  });
  api.registerHttpRoute({
    path: "/plugins/diffs",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res): Promise<boolean> => {
      const parsed = req.url ? URL.parse(req.url, "http://127.0.0.1") : null;
      if (!parsed) {
        return false;
      }

      if (parsed.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
        return await serveAsset(req, res, parsed.pathname, api.logger);
      }

      if (!parsed.pathname.startsWith(VIEW_PREFIX)) {
        return false;
      }

      const currentConfig = api.runtime.config.current() as OpenClawConfig;
      const pluginConfig = resolveCurrentPluginConfig();
      const allowRemoteViewer = resolveDiffsPluginSecurity(pluginConfig).allowRemoteViewer;
      const trustedProxies = currentConfig.gateway?.trustedProxies;
      const proxyHintsPresent = hasProxyForwardingHints(req);
      const clientIp =
        proxyHintsPresent || (trustedProxies?.length ?? 0) > 0
          ? // Reuse gateway proxy trust rules and fail closed when a trusted proxy hop
            // does not provide usable client-origin headers.
            resolveRequestClientIp(
              req,
              trustedProxies ? [...trustedProxies] : undefined,
              currentConfig.gateway?.allowRealIpFallback === true,
            )
          : req.socket?.remoteAddress;
      const remoteKey = normalizeRemoteClientKey(clientIp ?? req.socket?.remoteAddress);
      const localRequest =
        !proxyHintsPresent && typeof clientIp === "string" && isLoopbackHost(remoteKey);
      if (!localRequest && !allowRemoteViewer) {
        respondText(res, 404, "Diff not found");
        return true;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        respondText(res, 405, "Method not allowed");
        return true;
      }

      if (!localRequest) {
        const throttled = viewerFailureLimiter.check(remoteKey);
        if (!throttled.allowed) {
          res.setHeader(
            "Retry-After",
            String(Math.max(1, Math.ceil(throttled.retryAfterMs / 1000))),
          );
          respondText(res, 429, "Too Many Requests");
          return true;
        }
      }

      const recordRemoteFailure = () => {
        if (!localRequest) {
          viewerFailureLimiter.recordFailure(remoteKey);
        }
      };

      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const id = pathParts[3];
      const token = pathParts[4];
      if (
        !id ||
        !token ||
        !DIFF_ARTIFACT_ID_PATTERN.test(id) ||
        !DIFF_ARTIFACT_TOKEN_PATTERN.test(token)
      ) {
        recordRemoteFailure();
        respondText(res, 404, "Diff not found");
        return true;
      }

      try {
        // Authorization and payload read share one SQLite row snapshot. Keeping
        // them together prevents a replacement between token check and response.
        const viewer = await store.readAuthorizedViewer(id, token);
        if (!viewer) {
          recordRemoteFailure();
          respondText(res, 404, "Diff not found or expired");
          return true;
        }
        if (!localRequest) {
          viewerFailureLimiter.reset(remoteKey);
        }
        res.statusCode = 200;
        setSharedHeaders(res, "text/html; charset=utf-8");
        res.setHeader("content-security-policy", VIEWER_CONTENT_SECURITY_POLICY);
        res.setHeader("content-length", String(viewer.html.byteLength));
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(Buffer.from(viewer.html));
        }
        return true;
      } catch (error) {
        recordRemoteFailure();
        api.logger?.warn(`Failed to serve diff artifact ${id}: ${String(error)}`);
        respondText(res, 500, "Failed to load diff");
        return true;
      }
    },
  });
  api.on("before_prompt_build", async () => ({
    prependSystemContext: DIFFS_AGENT_GUIDANCE,
  }));
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger?: PluginLogger,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respondText(res, 405, "Method not allowed");
    return true;
  }

  try {
    const asset = await getServedViewerAsset(pathname);
    if (!asset) {
      respondText(res, 404, "Asset not found");
      return true;
    }

    res.statusCode = 200;
    setSharedHeaders(
      res,
      asset.contentType,
      pathname === VIEWER_RUNTIME_PATH ? IMMUTABLE_ASSET_CACHE_CONTROL : undefined,
    );
    res.setHeader("content-length", String(Buffer.byteLength(asset.body)));
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(asset.body);
    }
    return true;
  } catch (error) {
    logger?.warn(`Failed to serve diffs asset ${pathname}: ${String(error)}`);
    respondText(res, 500, "Failed to load asset");
    return true;
  }
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  // Node suppresses the HEAD body but never synthesizes Content-Length; set it
  // explicitly so error responses keep GET/HEAD header parity (RFC 9110 §8.6).
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

function setSharedHeaders(
  res: ServerResponse,
  contentType: string,
  cacheControl = "no-store, max-age=0",
): void {
  res.setHeader("cache-control", cacheControl);
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function normalizeRemoteClientKey(remoteAddress: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(remoteAddress);
  if (!normalized) {
    return "unknown";
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function hasProxyForwardingHints(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  return Boolean(
    headers["x-forwarded-for"] ||
    headers["x-real-ip"] ||
    headers.forwarded ||
    headers["x-forwarded-host"] ||
    headers["x-forwarded-proto"],
  );
}

function resolveDiffsLanguagePackAvailability(api: OpenClawPluginApi): boolean {
  const currentConfig = api.runtime.config.current() as OpenClawConfig;
  const plugins = currentConfig.plugins;
  if (plugins?.enabled === false) {
    return false;
  }
  if (plugins?.deny?.includes(DIFFS_LANGUAGE_PACK_PLUGIN_ID)) {
    return false;
  }
  if (plugins?.allow && !plugins.allow.includes(DIFFS_LANGUAGE_PACK_PLUGIN_ID)) {
    return false;
  }
  if (plugins?.entries?.[DIFFS_LANGUAGE_PACK_PLUGIN_ID]?.enabled === false) {
    return false;
  }
  return hasSiblingLanguagePackRuntime(api.rootDir);
}

function hasSiblingLanguagePackRuntime(rootDir: string | undefined): boolean {
  if (!rootDir) {
    return false;
  }
  const languagePackRoot = path.join(path.dirname(rootDir), DIFFS_LANGUAGE_PACK_PLUGIN_ID);
  const runtimePaths = [
    path.join(languagePackRoot, "assets", "viewer-runtime.js"),
    path.join(languagePackRoot, "dist", "assets", "viewer-runtime.js"),
  ];
  return (
    fs.existsSync(path.join(languagePackRoot, "openclaw.plugin.json")) &&
    runtimePaths.some((runtimePath) => fs.existsSync(runtimePath))
  );
}
