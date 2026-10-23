import crypto from "node:crypto";
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { safeParseJson, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
  browserProxyUploadUnavailableMessage,
} from "./browser-node-commands.js";
import { isBrowserControlHostUnavailableError } from "./browser-node-fallback.js";
import type { BrowserNodeTarget } from "./browser-node-routing.js";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
  parseBrowserProxyFailure,
  parseBrowserProxyRoute,
  type BrowserProxyEnvelope,
  type BrowserProxyRoute,
} from "./browser-proxy-envelope.js";
import { resolveBrowserProxyTimeouts } from "./browser-proxy-timeouts.js";
import {
  isBrowserProxyUploadRequest,
  prepareBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";
import { BrowserServiceError, fetchBrowserJson } from "./browser/client-fetch.js";
import { persistBrowserProxyResultFiles } from "./browser/proxy-files.js";
import {
  parseBrowserSessionTabCloseResult,
  type BrowserSessionTabRoute,
} from "./browser/session-tab-route.js";

const logger = createSubsystemLogger("browser");

class BrowserNodeSafeFallbackError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserNodeSafeFallbackError";
  }
}

export type BrowserProxyRequest = ((params: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  signal?: AbortSignal;
}) => Promise<unknown>) & {
  isHostFallbackActive: () => boolean;
  route: () => BrowserProxyRoute | undefined;
};

async function callLocalBrowserControl(params: Parameters<BrowserProxyRequest>[0]) {
  const url = new URL(params.path, "http://localhost");
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  if (params.profile) {
    url.searchParams.set("profile", params.profile);
  }
  return await fetchBrowserJson(`${url.pathname}${url.search}`, {
    method: params.method,
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

export function createBrowserNodeProxyRequest(params: {
  nodeTarget: BrowserNodeTarget;
  allowAutomaticHostFallback: boolean;
  signal?: AbortSignal;
}): BrowserProxyRequest {
  let target: "auto" | "node" | "host" = params.allowAutomaticHostFallback ? "auto" : "node";
  let route: BrowserProxyRoute | undefined;
  const dispatch = async (request: Parameters<BrowserProxyRequest>[0]) => {
    // Bind cancellation once so every node action and its safe host fallback
    // inherit their execution signal without overriding an explicit request.
    const requestWithSignal =
      request.signal || params.signal
        ? { ...request, signal: request.signal ?? params.signal }
        : request;
    if (target === "host") {
      return await callLocalBrowserControl(requestWithSignal);
    }
    try {
      const proxyParams = {
        nodeId: params.nodeTarget.nodeId,
        nodeLabel: params.nodeTarget.label,
        declaredCommands: params.nodeTarget.commands ?? [],
        pendingDeclaredCommands: params.nodeTarget.pendingDeclaredCommands ?? [],
        allowAutomaticHostFallback: target === "auto",
        ...requestWithSignal,
      };
      const { proxyTimeoutMs, nodeInvokeTimeoutMs, gatewayTimeoutMs } = resolveBrowserProxyTimeouts(
        proxyParams.timeoutMs,
      );
      if (
        isBrowserProxyUploadRequest(proxyParams) &&
        !proxyParams.declaredCommands.includes(BROWSER_PROXY_UPLOAD_COMMAND)
      ) {
        throw new BrowserNodeSafeFallbackError(
          browserProxyUploadUnavailableMessage(proxyParams.pendingDeclaredCommands),
        );
      }
      const preparedUpload = await prepareBrowserProxyUploadRequest({
        method: proxyParams.method,
        path: proxyParams.path,
        body: proxyParams.body,
        signal: proxyParams.signal,
      });
      const command = preparedUpload.upload ? BROWSER_PROXY_UPLOAD_COMMAND : BROWSER_PROXY_COMMAND;
      let payload: { payload?: unknown; payloadJSON?: unknown } | null;
      try {
        payload = await callGatewayTool<{ payload?: unknown; payloadJSON?: unknown }>(
          "node.invoke",
          { timeoutMs: gatewayTimeoutMs },
          {
            nodeId: proxyParams.nodeId,
            command,
            // Keep the browser action, node watchdog, and Gateway RPC on distinct
            // budgets so a detailed node timeout can cross both outer boundaries.
            timeoutMs: nodeInvokeTimeoutMs,
            params: {
              method: proxyParams.method,
              path: proxyParams.path,
              query: proxyParams.query,
              body: preparedUpload.body,
              upload: preparedUpload.upload,
              timeoutMs: proxyTimeoutMs,
              profile: proxyParams.profile,
              errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
            },
            idempotencyKey: crypto.randomUUID(),
          },
          {
            scopes: ["operator.admin"],
            ...(proxyParams.signal ? { signal: proxyParams.signal } : {}),
          },
        );
      } catch (error) {
        if (proxyParams.allowAutomaticHostFallback && isBrowserControlHostUnavailableError(error)) {
          throw new BrowserNodeSafeFallbackError("browser node control host unavailable", error);
        }
        throw error;
      }
      const proxy =
        payload?.payload !== undefined
          ? (payload.payload as BrowserProxyEnvelope)
          : typeof payload?.payloadJSON === "string" && payload.payloadJSON.trim()
            ? safeParseJson<BrowserProxyEnvelope>(payload.payloadJSON)
            : null;
      if (
        !proxy ||
        typeof proxy !== "object" ||
        (!("result" in proxy) && !parseBrowserProxyFailure(proxy))
      ) {
        const selectedNode = truncateUtf16Safe(
          proxyParams.nodeLabel?.trim() || proxyParams.nodeId,
          256,
        );
        throw new Error(
          `Browser proxy returned an invalid response from node ${JSON.stringify(selectedNode)}. Retry with action=status target="host" to check Gateway host browser control.`,
        );
      }
      // A follow-up snapshot or setting belongs to the browser that already
      // handled this action, even if that node subsequently becomes unavailable.
      target = "node";
      route = parseBrowserProxyRoute(proxy);
      const failure = parseBrowserProxyFailure(proxy);
      if (failure) {
        const { status, body } = failure.error;
        throw new BrowserServiceError(body.error, body, status);
      }
      if (!("result" in proxy)) {
        throw new Error("Browser proxy returned a failure without an error payload.");
      }
      return await persistBrowserProxyResultFiles(proxy.result, proxy.files);
    } catch (error) {
      if (target !== "auto" || !(error instanceof BrowserNodeSafeFallbackError)) {
        throw error;
      }
      // These failures are detected before route dispatch. Retrying any later
      // failure could duplicate a mutating browser action.
      target = "host";
      route = undefined;
      logger.warn(
        `browser node ${params.nodeTarget.label ?? params.nodeTarget.nodeId} unavailable before dispatch (${error.message}); falling back to Gateway host`,
      );
      return await callLocalBrowserControl(requestWithSignal);
    }
  };
  return Object.assign(dispatch, {
    isHostFallbackActive: () => target === "host",
    route: () => route,
  });
}

export function createBrowserNodeSessionTabRoute(
  nodeTarget: BrowserNodeTarget,
): Extract<BrowserSessionTabRoute, { kind: "node-proxy" }> {
  return {
    kind: "node-proxy",
    nodeId: nodeTarget.nodeId,
    closeTarget: async (tab) => {
      const cleanupProxy = createBrowserNodeProxyRequest({
        nodeTarget,
        allowAutomaticHostFallback: false,
      });
      if (tab.ownership?.status === "durable") {
        return parseBrowserSessionTabCloseResult(
          await cleanupProxy({
            method: "POST",
            path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
            body: { ownership: tab.ownership },
            profile: tab.profile,
          }),
        );
      }
      await cleanupProxy({
        method: "DELETE",
        path: `/tabs/${encodeURIComponent(tab.targetId)}`,
        query: { targetIdMode: "raw" },
        profile: tab.profile,
      });
      return { status: "closed" };
    },
  };
}
