import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  ErrorCodes,
  applyBrowserProxyPaths,
  createBrowserControlContext,
  createBrowserRouteDispatcher,
  errorShape,
  isNodeCommandAllowed,
  isPersistentBrowserProfileMutation,
  loadConfig,
  normalizeBrowserRequestPath,
  persistBrowserProxyFiles,
  resolveBrowserConfig,
  resolveNodeCommandAllowlist,
  resolveRequestedBrowserProfile,
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
  startBrowserControlServiceFromConfig,
  withTimeout,
  type GatewayRequestHandlers,
  type NodeSession,
} from "../core-api.js";

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const ABORT_AWARE_LOCAL_ACT_KINDS = new Set([
  "click",
  "type",
  "press",
  "hover",
  "scrollIntoView",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
  "batch",
]);

const LOCAL_TIMEOUT_UNSAFE_PATHS = new Set([
  "/act",
  "/download",
  "/highlight",
  "/hooks/dialog",
  "/hooks/file-chooser",
  "/response/body",
  "/screenshot",
  "/snapshot",
  "/wait/download",
]);

function isBrowserNode(node: NodeSession) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

function normalizeNodeKey(value: string) {
  return normalizeLowercaseStringOrEmpty(value).replace(/[^a-z0-9]+/g, "");
}

function resolveBrowserNode(nodes: NodeSession[], query: string) {
  const q = normalizeOptionalString(query) ?? "";
  if (!q) {
    return null;
  }
  const qNorm = normalizeNodeKey(q);
  const matches = nodes.filter((node) => {
    if (node.nodeId === q) {
      return true;
    }
    if (typeof node.remoteIp === "string" && node.remoteIp === q) {
      return true;
    }
    const name = typeof node.displayName === "string" ? node.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) {
      return true;
    }
    if (q.length >= 6 && node.nodeId.startsWith(q)) {
      return true;
    }
    return false;
  });
  if (matches.length === 1) {
    return matches[0] ?? null;
  }
  if (matches.length === 0) {
    return null;
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((node) => node.displayName || node.remoteIp || node.nodeId)
      .join(", ")})`,
  );
}

function resolveBrowserNodeTarget(params: {
  cfg: ReturnType<typeof loadConfig>;
  nodes: NodeSession[];
}) {
  const policy = params.cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    return null;
  }
  const browserNodes = params.nodes.filter((node) => isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (normalizeOptionalString(policy?.node)) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }
  const requested = normalizeOptionalString(policy?.node) ?? "";
  if (requested) {
    const resolved = resolveBrowserNode(browserNodes, requested);
    if (!resolved) {
      throw new Error(`Configured browser node not connected: ${requested}`);
    }
    return resolved;
  }
  if (mode === "manual") {
    return null;
  }
  if (browserNodes.length === 1) {
    return browserNodes[0] ?? null;
  }
  return null;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

function resolveRequestedProfileDriver(params: {
  cfg: ReturnType<typeof loadConfig>;
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const resolvedBrowser = resolveBrowserConfig(params.cfg.browser, params.cfg);
  const profileName =
    resolveRequestedBrowserProfile({ query: params.query, body: params.body }) ??
    resolvedBrowser.defaultProfile;
  if (!profileName) {
    return undefined;
  }
  const profile = resolvedBrowser.profiles[profileName];
  return typeof profile?.driver === "string" ? profile.driver : undefined;
}

function shouldWrapLocalBrowserRequestWithTimeout(params: {
  cfg: ReturnType<typeof loadConfig>;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}) {
  const path = normalizeBrowserRequestPath(params.path);
  let requestedProfileDriver: string | undefined;
  try {
    requestedProfileDriver = resolveRequestedProfileDriver(params);
  } catch {
    // Preserve the generic local timeout behavior when config resolution fails;
    // downstream dispatch/setup paths already surface the underlying config error.
    requestedProfileDriver = undefined;
  }
  if (requestedProfileDriver === "existing-session") {
    return false;
  }
  if (!LOCAL_TIMEOUT_UNSAFE_PATHS.has(path)) {
    return true;
  }
  if (path !== "/act" || !params.body || typeof params.body !== "object") {
    return false;
  }
  const kind =
    "kind" in params.body && typeof params.body.kind === "string" ? params.body.kind.trim() : "";
  return ABORT_AWARE_LOCAL_ACT_KINDS.has(kind);
}

export async function handleBrowserGatewayRequest({
  params,
  respond,
  context,
}: Parameters<GatewayRequestHandlers["browser.request"]>[0]) {
  const typed = params as BrowserRequestParams;
  const methodRaw = (normalizeOptionalString(typed.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(typed.path) ?? "";
  const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
  const body = typed.body;
  const timeoutMs =
    typeof typed.timeoutMs === "number" && Number.isFinite(typed.timeoutMs)
      ? Math.max(1, Math.floor(typed.timeoutMs))
      : undefined;

  if (!methodRaw || !path) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
    );
    return;
  }
  if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
    );
    return;
  }
  if (isPersistentBrowserProfileMutation(methodRaw, path)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "browser.request cannot mutate persistent browser profiles",
      ),
    );
    return;
  }

  const cfg = loadConfig();
  let nodeTarget = null as ReturnType<typeof resolveBrowserNodeTarget>;
  try {
    nodeTarget = resolveBrowserNodeTarget({
      cfg,
      nodes: context.nodeRegistry.listConnected(),
    });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  if (nodeTarget) {
    const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
    const allowed = isNodeCommandAllowed({
      command: "browser.proxy",
      declaredCommands: nodeTarget.commands,
      allowlist,
    });
    if (!allowed.ok) {
      const platform = nodeTarget.platform ?? "unknown";
      const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: browser.proxy)`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, hint, {
          details: { reason: allowed.reason, command: "browser.proxy" },
        }),
      );
      return;
    }

    const proxyParams = {
      method: methodRaw,
      path,
      query,
      body,
      timeoutMs,
      profile: resolveRequestedBrowserProfile({ query, body }),
    };
    const res = await context.nodeRegistry.invoke({
      nodeId: nodeTarget.nodeId,
      command: "browser.proxy",
      params: proxyParams,
      timeoutMs,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!respondUnavailableOnNodeInvokeError(respond, res)) {
      return;
    }
    const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
    const proxy = payload && typeof payload === "object" ? (payload as BrowserProxyResult) : null;
    if (!proxy || !("result" in proxy)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
      return;
    }
    const mapping = await persistProxyFiles(proxy.files);
    applyProxyPaths(proxy.result, mapping);
    respond(true, proxy.result);
    return;
  }

  const ready = await startBrowserControlServiceFromConfig();
  if (!ready) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
    return;
  }

  let dispatcher;
  try {
    dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  const shouldApplyLocalTimeout =
    timeoutMs !== undefined && shouldWrapLocalBrowserRequestWithTimeout({ cfg, path, query, body });

  let result;
  try {
    result = shouldApplyLocalTimeout
      ? await withTimeout(
          async (signal: AbortSignal) =>
            await dispatcher.dispatch({
              method: methodRaw,
              path,
              query,
              body,
              signal,
            }),
          timeoutMs,
          "browser request",
        )
      : await dispatcher.dispatch({
          method: methodRaw,
          path,
          query,
          body,
        });
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  if (result.status >= 400) {
    const message =
      result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error?: unknown }).error)
        : `browser request failed (${result.status})`;
    const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
    respond(false, undefined, errorShape(code, message, { details: result.body }));
    return;
  }

  respond(true, result.body);
}

export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": handleBrowserGatewayRequest,
};
