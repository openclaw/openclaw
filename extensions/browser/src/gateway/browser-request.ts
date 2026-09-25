/**
 * Gateway handler for browser.request, including optional node-host proxy
 * dispatch and local Browser control route dispatch.
 */
import crypto from "node:crypto";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import {
  inspectBrowserDashboard,
  requestBrowserDashboard,
  stopBrowserDashboard,
  assertBrowserDashboardTargetCurrent,
} from "../browser-dashboard.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
  browserProxyUploadUnavailableMessage,
} from "../browser-node-commands.js";
import { isBrowserControlHostUnavailableError } from "../browser-node-fallback.js";
import { resolveBrowserNodeTarget } from "../browser-node-routing.js";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  parseBrowserProxyFailure,
  type BrowserProxyEnvelope,
  type BrowserProxySuccess,
} from "../browser-proxy-envelope.js";
import { resolveBrowserProxyTimeouts } from "../browser-proxy-timeouts.js";
import {
  isBrowserProxyUploadRequest,
  prepareBrowserProxyUploadRequest,
} from "../browser-proxy-upload.js";
import { applyBrowserTabToolBinding } from "../browser-tool-binding.js";
import { normalizeBrowserRequestPath } from "../browser/request-policy.js";
import type { BrowserRequest } from "../browser/routes/types.js";
import {
  ErrorCodes,
  createBrowserControlContext,
  createBrowserRouteDispatcher,
  errorShape,
  getRuntimeConfig,
  isBrowserHostLocalRoute,
  isNodeCommandAllowed,
  isPersistentBrowserProfileMutation,
  persistBrowserProxyResultFiles,
  resolveNodeCommandAllowlist,
  resolveRequestedBrowserProfile,
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
  startBrowserControlServiceFromConfig,
  withTimeout,
  type GatewayRequestHandlers,
  type NodeSession,
} from "../core-api.js";
import { describeBrowserControlUnavailable } from "../plugin-enabled.js";

const logger = createSubsystemLogger("browser");
const dashboardRequestSchema = z.object({
  sessionKey: z.string().trim().min(1),
  agentId: z.string().trim().min(1).optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  instanceId: z.string().min(1).optional(),
});

type BrowserRequestParams = {
  target?: "host" | "node";
  node?: string;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
  dashboard?: unknown;
};

/** Handles one browser.request gateway call and streams a success/error response. */
export async function handleBrowserGatewayRequest({
  params,
  respond,
  context,
  client,
  signal: invocationSignal,
  hasCurrentClientAuthority,
}: Parameters<GatewayRequestHandlers["browser.request"]>[0]) {
  const typed = params as BrowserRequestParams;
  const methodRaw = (normalizeOptionalString(typed.method) ?? "").toUpperCase();
  const path = normalizeBrowserRequestPath(normalizeOptionalString(typed.path) ?? "");
  let query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
  let body = typed.body;
  const timeoutMs = clampTimerTimeoutMs(typed.timeoutMs);
  const explicitNode = typed.target === "node";
  const requestedNode = normalizeOptionalString(typed.node);
  const connectionSignal = client?.connectionSignal;
  const requestSignal =
    invocationSignal && connectionSignal && invocationSignal !== connectionSignal
      ? AbortSignal.any([invocationSignal, connectionSignal])
      : (invocationSignal ?? connectionSignal);
  const isRequesterCurrent = () =>
    !requestSignal?.aborted &&
    !client?.invalidated &&
    !client?.connectionSignal?.aborted &&
    hasCurrentClientAuthority?.() !== false;
  const assertRequesterCurrent = () => {
    requestSignal?.throwIfAborted();
    if (!isRequesterCurrent()) {
      throw new Error("Browser requester is no longer active");
    }
  };

  if (
    (typed.target !== undefined && typed.target !== "host" && !explicitNode) ||
    (typed.node !== undefined &&
      (!explicitNode ||
        !requestedNode ||
        typeof typed.node !== "string" ||
        typed.node.length > 256))
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        'target must be "host" or "node"; node requires target="node" and a nonempty selector of at most 256 characters',
      ),
    );
    return;
  }

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
  if (path === "/dashboard") {
    if (typed.target === "node" || requestedNode) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Browser dashboards use a local managed browser on the Gateway host",
        ),
      );
      return;
    }
    const request = dashboardRequestSchema
      .extend({ resume: z.boolean().optional() })
      .safeParse(methodRaw === "GET" ? query : body);
    if (!request.success) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Browser dashboard requires sessionKey and a stable widget name",
        ),
      );
      return;
    }
    try {
      const run =
        methodRaw === "DELETE"
          ? stopBrowserDashboard
          : methodRaw === "GET"
            ? inspectBrowserDashboard
            : requestBrowserDashboard;
      const result = await run(request.data, {
        signal: requestSignal,
        assertCurrent: assertRequesterCurrent,
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
    }
    return;
  }
  let assertDashboardCurrent: BrowserRequest["assertCurrent"];
  if (typed.dashboard !== undefined) {
    const scope = dashboardRequestSchema.safeParse(typed.dashboard);
    if (!scope.success || explicitNode || requestedNode) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Dashboard requests require a valid local dashboard identity",
        ),
      );
      return;
    }
    try {
      const authority = { signal: requestSignal, assertCurrent: assertRequesterCurrent };
      const dashboard = await inspectBrowserDashboard(scope.data, authority);
      const tab = dashboard.browserTab;
      if (!tab || dashboard.paused) {
        throw new Error("Dashboard browser is paused or unavailable. Resume the dashboard first.");
      }
      if (
        path === "/tabs/open" ||
        path === "/tabs/action" ||
        path === "/start" ||
        path === "/stop" ||
        path === "/reset-profile" ||
        path.startsWith("/profiles") ||
        path.startsWith("/system-")
      ) {
        throw new Error("Use the dashboard controls to open or stop its retained tab");
      }
      if (
        methodRaw === "DELETE" &&
        path.startsWith("/tabs/") &&
        decodeURIComponent(path.slice(6)) !== tab.targetId
      ) {
        throw new Error("Dashboard request cannot address another browser tab");
      }
      const binding = { kind: "tab" as const, tabId: 0, ...tab };
      query = { ...applyBrowserTabToolBinding(query ?? {}, binding), managedOnly: true };
      const bodyRecord = asNullableRecord(body);
      if (bodyRecord || methodRaw === "POST") {
        body = applyBrowserTabToolBinding(bodyRecord ?? {}, binding);
      }
      assertDashboardCurrent = (profile) =>
        assertBrowserDashboardTargetCurrent(dashboard, scope.data.agentId, authority, profile);
      await assertDashboardCurrent();
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
      return;
    }
  }
  const cfg = getRuntimeConfig();
  const configuredNode = normalizeOptionalString(cfg.gateway?.nodes?.browser?.node);
  // System-profile listing and import can only run where the local Keychain and
  // Chrome profiles live, so they must never route to a browser node. Force
  // host-local dispatch even when gateway.nodes.browser auto-selects a node.
  const forceHostLocal =
    Boolean(assertDashboardCurrent) || isBrowserHostLocalRoute(methodRaw, path);
  if (forceHostLocal && explicitNode) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "this browser route must run on the Gateway host"),
    );
    return;
  }
  let nodeTarget: NodeSession | null = null;
  if (!forceHostLocal && typed.target !== "host") {
    try {
      nodeTarget = await resolveBrowserNodeTarget({
        nodes: () => context.nodeRegistry.listConnected(),
        config: cfg,
        profile: resolveRequestedBrowserProfile({ query, body }),
        explicitTarget: explicitNode,
        requestedNode,
      });
      assertRequesterCurrent();
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }
  }

  if (nodeTarget && path === "/screencast") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "browser screencast is not available over a node proxy",
        { details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" } },
      ),
    );
    return;
  }

  if (nodeTarget && isPersistentBrowserProfileMutation(methodRaw, path)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "browser.request cannot mutate persistent browser profiles over a node proxy",
      ),
    );
    return;
  }

  let preparedUpload: Awaited<ReturnType<typeof prepareBrowserProxyUploadRequest>> | null = null;
  let proxyCommand = BROWSER_PROXY_COMMAND;
  if (nodeTarget) {
    if (
      isBrowserProxyUploadRequest({ method: methodRaw, path, body }) &&
      !nodeTarget.commands?.includes(BROWSER_PROXY_UPLOAD_COMMAND)
    ) {
      const message = browserProxyUploadUnavailableMessage(nodeTarget.declaredCommands);
      if (explicitNode || configuredNode) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        return;
      }
      logger.warn(
        `browser node ${nodeTarget.displayName ?? nodeTarget.nodeId} lacks ${BROWSER_PROXY_UPLOAD_COMMAND}; falling back to Gateway host`,
      );
      nodeTarget = null;
    }
  }
  if (nodeTarget) {
    try {
      assertRequesterCurrent();
      preparedUpload = await prepareBrowserProxyUploadRequest({
        method: methodRaw,
        path,
        body,
        signal: requestSignal,
      });
      assertRequesterCurrent();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      return;
    }
    if (preparedUpload.upload) {
      proxyCommand = BROWSER_PROXY_UPLOAD_COMMAND;
    }
  }

  if (nodeTarget && preparedUpload) {
    const allowlist = resolveNodeCommandAllowlist(cfg, nodeTarget);
    const allowed = isNodeCommandAllowed({
      command: proxyCommand,
      declaredCommands: nodeTarget.commands,
      allowlist,
    });
    if (!allowed.ok) {
      const platform = nodeTarget.platform ?? "unknown";
      const hint = `node command not allowed: ${allowed.reason} (platform: ${platform}, command: ${proxyCommand})`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, hint, {
          details: { reason: allowed.reason, command: proxyCommand },
        }),
      );
      return;
    }

    const { proxyTimeoutMs, nodeInvokeTimeoutMs } = resolveBrowserProxyTimeouts(timeoutMs);
    const proxyParams = {
      method: methodRaw,
      path,
      query,
      body: preparedUpload.body,
      upload: preparedUpload.upload,
      timeoutMs: proxyTimeoutMs,
      profile: resolveRequestedBrowserProfile({ query, body }),
      errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
    };
    let res;
    try {
      assertRequesterCurrent();
      res = await context.nodeRegistry.invoke({
        nodeId: nodeTarget.nodeId,
        command: proxyCommand,
        params: proxyParams,
        timeoutMs: nodeInvokeTimeoutMs,
        signal: requestSignal,
        isDispatchAuthorized: isRequesterCurrent,
        idempotencyKey: crypto.randomUUID(),
      });
      assertRequesterCurrent();
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      return;
    }
    const allowAutomaticHostFallback =
      !explicitNode && !configuredNode && isBrowserControlHostUnavailableError(res.error);
    if (allowAutomaticHostFallback && !res.ok) {
      // This node-host error is raised before route dispatch. Other failures
      // stay on the node path because retrying could duplicate an action.
      logger.warn(
        `browser node ${nodeTarget.displayName ?? nodeTarget.nodeId} control host unavailable; falling back to Gateway host`,
      );
    } else {
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      const failure = parseBrowserProxyFailure(payload);
      if (failure) {
        const { status, body: errorBody } = failure.error;
        const code = status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
        respond(false, undefined, errorShape(code, errorBody.error, { details: errorBody }));
        return;
      }
      const proxy =
        payload && typeof payload === "object" ? (payload as BrowserProxyEnvelope) : null;
      if (!proxy || !("result" in proxy)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser proxy failed"));
        return;
      }
      const success = proxy as BrowserProxySuccess;
      try {
        const result = await persistBrowserProxyResultFiles(success.result, success.files);
        assertRequesterCurrent();
        respond(true, result);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "browser proxy file transfer failed"),
        );
      }
      return;
    }
  }

  // `browser.request` already requires operator.admin. The owning host may run
  // profile administration; the node-proxy branch above stays denied because
  // `browser.proxy` is a separate remote-host authority.
  const ready = await startBrowserControlServiceFromConfig();
  if (!ready) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, await describeBrowserControlUnavailable()),
    );
    return;
  }

  let dispatcher;
  try {
    dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  // Invalidation precedes the socket's close event; retain live authority separately.
  const requesterSignal = connectionSignal;
  const requester =
    client && requesterSignal
      ? {
          connId: client.connId,
          signal: requesterSignal,
          isCurrent: () =>
            client.invalidated !== true &&
            !requesterSignal.aborted &&
            hasCurrentClientAuthority?.() !== false,
        }
      : undefined;
  const assertCurrent: NonNullable<BrowserRequest["assertCurrent"]> = async (profile) => {
    assertRequesterCurrent();
    await assertDashboardCurrent?.(profile);
    assertRequesterCurrent();
  };
  const dispatch = (timeoutSignal?: AbortSignal) =>
    dispatcher.dispatch({
      method: methodRaw,
      path,
      query,
      body,
      signal:
        timeoutSignal && requestSignal
          ? AbortSignal.any([timeoutSignal, requestSignal])
          : (timeoutSignal ?? requestSignal),
      ...(requester ? { requester } : {}),
      assertCurrent,
    });
  let result;
  try {
    await assertCurrent();
    result = timeoutMs
      ? await withTimeout(dispatch, timeoutMs, "browser request")
      : await dispatch();
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

/** Gateway request handler map contributed by the Browser plugin. */
export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": handleBrowserGatewayRequest,
};
