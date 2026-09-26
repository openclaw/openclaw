/**
 * Browser agent tool registration.
 *
 * Builds the model-facing browser tool, chooses sandbox/host/node routing, and
 * maps high-level actions onto browser control client calls.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { assertBrowserDashboardTargetCurrent } from "./browser-dashboard.js";
import type { BrowserDashboardResponse } from "./browser-dashboard.types.js";
import {
  createBrowserNodeProxyRequest,
  createBrowserNodeSessionTabRoute,
  type BrowserProxyRequest,
} from "./browser-node-proxy.js";
import { applyBrowserTabToolBinding } from "./browser-tool-binding.js";
import { createBrowserToolDefinition } from "./browser-tool-description.js";
import { executeBrowserTabAction } from "./browser-tool-dispatch.js";
import { createBrowserToolSessionTabs } from "./browser-tool-session-tabs.js";
import { executeBrowserLifecycleAction } from "./browser-tool.lifecycle.js";
import {
  resolveBrowserBaseUrl,
  resolveBrowserToolNodeTarget,
  resolveBrowserToolTimeoutMs,
  type BrowserNodeTarget,
} from "./browser-tool.routing.js";
import {
  type AnyAgentTool,
  type browserAct,
  type BrowserToolCapabilities,
  getRuntimeConfig,
  getBrowserProfileCapabilities,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveProfile,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
  jsonResult,
  callGatewayTool,
  readGatewayToolOperatorScopes,
} from "./browser-tool.runtime.js";
import type { BrowserScreenshotOptions } from "./browser-tool.screenshot.js";
import { withBrowserRequestScope } from "./browser/request-scope.js";

type BrowserTabIdentity = { targetId: string; profile: string } & (
  | { target: "host" }
  | { target: "node"; node: string }
);

function isBrowserRouteIdentifier(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value
  );
}

function resolveBrowserTabIdentity(params: {
  targetId?: string;
  profile?: string;
  target: "host" | "node";
  node?: string;
  baseUrl?: string;
}): BrowserTabIdentity | undefined {
  // Bridge/sandbox tabs have no operator browser.request route. Identity must
  // remain exact: truncation could address another tab, profile, or node.
  if (
    params.baseUrl ||
    !isBrowserRouteIdentifier(params.targetId, 128) ||
    !isBrowserRouteIdentifier(params.profile, 128)
  ) {
    return undefined;
  }
  if (params.target === "node") {
    return isBrowserRouteIdentifier(params.node, 256)
      ? { targetId: params.targetId, profile: params.profile, target: "node", node: params.node }
      : undefined;
  }
  return { targetId: params.targetId, profile: params.profile, target: "host" };
}

function withBrowserTabDetails(
  result: AgentToolResult<unknown>,
  identity: BrowserTabIdentity | undefined,
): AgentToolResult<unknown> {
  // UI addressing only; normal tool content and authorization stay unchanged.
  const details = asNullableRecord(result.details);
  if (
    !identity ||
    !details ||
    details.ok === false ||
    details.isError === true ||
    (Array.isArray(details.results) &&
      details.results.some((entry) => asNullableRecord(entry)?.ok === false)) ||
    asNullableRecord(details.aborted)?.reason === "closed"
  ) {
    return result;
  }
  const url = readStringValue(details.url);
  const protocol = url ? URL.parse(url)?.protocol : undefined;
  const title = readStringValue(details.title);
  return {
    ...result,
    details: {
      ...details,
      browserTab: {
        ...identity,
        ...(url && (protocol === "http:" || protocol === "https:")
          ? { url: truncateUtf16Safe(url, 2048) }
          : {}),
        ...(title ? { title: truncateUtf16Safe(title, 512) } : {}),
      },
    },
  };
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "kind",
  "actions",
  "stopOnError",
  "targetId",
  "ref",
  "doubleClick",
  "button",
  "modifiers",
  "x",
  "y",
  "text",
  "submit",
  "slowly",
  "key",
  "delayMs",
  "startRef",
  "endRef",
  "values",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "timeoutMs",
] as const;

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  const nestedRequest =
    requestParam && typeof requestParam === "object"
      ? { ...(requestParam as Record<string, unknown>) }
      : undefined;
  if (!nestedRequest && !readStringParam(params, "kind")) {
    return undefined;
  }
  const request = nestedRequest ?? {};
  const hasMismatchedKind =
    typeof request.kind === "string" &&
    typeof params.kind === "string" &&
    request.kind !== params.kind;
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (Object.hasOwn(request, key) || !Object.hasOwn(params, key)) {
      continue;
    }
    // Only tab scope can cross mismatched kinds; action-specific flattened
    // fields would corrupt an explicit nested request.
    if (hasMismatchedKind && key !== "targetId") {
      continue;
    }
    request[key] = params[key];
  }
  return request as Parameters<typeof browserAct>[1];
}

function readToolTimeoutMs(params: Record<string, unknown>) {
  return readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
}

/** Create the Browser tool exposed to agents. */
export function createBrowserTool(
  opts?: BrowserScreenshotOptions & {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
    agentSessionKey?: string;
    agentId?: string;
    runToolBinding?: unknown;
    toolCapabilities?: BrowserToolCapabilities;
  },
): AnyAgentTool {
  const { binding, capabilities, metadata } = createBrowserToolDefinition(opts, getRuntimeConfig);
  return {
    ...metadata,
    execute: async (_toolCallId, args, signal) => {
      let params = binding
        ? applyBrowserTabToolBinding(args as Record<string, unknown>, binding)
        : (args as Record<string, unknown>);
      const action = readStringParam(params, "action", { required: true });
      if (!capabilities.actions.some((candidate) => candidate === action)) {
        throw new Error(
          `browser action ${JSON.stringify(action)} is unavailable for this run; use an available action such as snapshot, or select a managed browser profile in an unbound run.`,
        );
      }
      const dashboardName = readStringParam(params, "dashboard");
      let browserDashboard: BrowserDashboardResponse | undefined;
      if (dashboardName) {
        const operatorScopes = readGatewayToolOperatorScopes();
        const sessionScoped =
          operatorScopes !== undefined && !operatorScopes.includes("operator.admin");
        const dashboardScopes = sessionScoped
          ? operatorScopes.includes("operator.write")
            ? ["operator.write" as const]
            : ["operator.sessions.write" as const]
          : ["operator.admin" as const];
        if (
          binding ||
          !opts?.agentSessionKey ||
          opts.allowHostControl === false ||
          (params.target && params.target !== "host") ||
          params.node
        ) {
          throw new Error(
            "Browser dashboard requires this session's unbound host-browser capability",
          );
        }
        const request = {
          sessionKey: opts.agentSessionKey,
          agentId: opts.agentId,
          name: dashboardName,
        };
        if (params.profile !== undefined || params.targetId !== undefined) {
          throw new Error(
            "A dashboard selector owns its browser profile and tab. Omit profile and targetId.",
          );
        }
        const callDashboard = async (method: "POST" | "DELETE", resume = false) => {
          signal?.throwIfAborted();
          // UI and model tools must enter the same Gateway-owned materialization lifetime.
          const dashboard = await callGatewayTool<BrowserDashboardResponse>(
            sessionScoped ? "browser.dashboard.request" : "browser.request",
            { timeoutMs: readToolTimeoutMs(params) },
            {
              ...(sessionScoped
                ? { sessionKey: request.sessionKey, agentId: request.agentId }
                : { target: "host" }),
              method,
              path: "/dashboard",
              body: { ...request, ...(resume ? { resume: true } : {}) },
            },
            { scopes: dashboardScopes, signal },
          );
          signal?.throwIfAborted();
          return dashboard;
        };
        if (action === "close") {
          return jsonResult({ browserDashboard: await callDashboard("DELETE") });
        }
        if (action === "open") {
          if (params.targetUrl !== undefined || params.url !== undefined) {
            throw new Error(
              "Update the dashboard widget URL with dashboard widget_put before opening it",
            );
          }
          return jsonResult({
            browserDashboard: await callDashboard("POST", true),
          });
        }
        if (["doctor", "status", "start", "stop", "profiles", "importprofile"].includes(action)) {
          throw new Error(
            "Use browser tab actions with a dashboard selector; open resumes it and close pauses it",
          );
        }
        const dashboard = await callDashboard("POST");
        browserDashboard = dashboard;
        if (!dashboard.browserTab) {
          throw new Error(
            `Dashboard ${dashboardName} is paused. Use action=open with dashboard=${dashboardName} to resume it.`,
          );
        }
        params = applyBrowserTabToolBinding(params, {
          kind: "tab",
          tabId: 0,
          ...dashboard.browserTab,
        });
        if (sessionScoped) {
          if (!["tabs", "focus", "navigate", "snapshot", "screenshot", "act"].includes(action)) {
            throw new Error(
              "Session dashboards support tabs, focus, navigate, snapshot, screenshot and act; open resumes and close pauses them.",
            );
          }
          const stripSelectors = (input: Record<string, unknown> | undefined) => {
            if (!input) {
              return undefined;
            }
            const {
              targetId: _targetId,
              profile: _profile,
              target: _target,
              node: _node,
              ...rest
            } = input;
            return rest;
          };
          const proxyRequest: BrowserProxyRequest = Object.assign(
            async (call: Parameters<BrowserProxyRequest>[0]) => {
              return callGatewayTool(
                "browser.dashboard.request",
                { timeoutMs: call.timeoutMs },
                {
                  sessionKey: request.sessionKey,
                  agentId: request.agentId,
                  dashboard: { name: dashboardName, instanceId: dashboard.instanceId },
                  method: call.method,
                  path: call.path,
                  query: stripSelectors(call.query),
                  body: stripSelectors(asNullableRecord(call.body) ?? undefined),
                },
                { scopes: dashboardScopes, signal: call.signal ?? signal },
              );
            },
            { isHostFallbackActive: () => false, route: () => undefined },
          );
          const result = await executeBrowserTabAction({
            action,
            params,
            actRequest: action === "act" ? readActRequestParam(params) : undefined,
            profile: dashboard.browserTab.profile,
            proxyRequest,
            capabilities,
            isUserBrowserProfile: false,
            boundTargetId: dashboard.browserTab.targetId,
            requestedTimeoutMs: readToolTimeoutMs(params),
            signal,
            opts,
            sessionTabs: {
              touch: () => {},
              untrack: () => {},
              trackOpened: async () => {
                throw new Error("Dashboard owns its context.");
              },
            },
            onTabActivity: () => {},
          });
          return {
            ...result,
            details: { ...asNullableRecord(result.details), browserDashboard: dashboard },
          };
        }
      }
      const requestedProfile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      const requestedTimeoutMs = readToolTimeoutMs(params);
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
      const runtimeConfig = getRuntimeConfig();
      const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
      const effectiveProfile = requestedProfile ?? resolvedBrowser.defaultProfile;
      const resolvedProfile = resolveProfile(resolvedBrowser, effectiveProfile);
      const profileCapabilities = resolvedProfile
        ? getBrowserProfileCapabilities(resolvedProfile)
        : undefined;
      let profile = profileCapabilities?.usesChromeMcp ? effectiveProfile : requestedProfile;
      const configuredNode = runtimeConfig.gateway?.nodes?.browser?.node?.trim();

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      // System-profile import reads the local macOS Keychain and Chrome profile,
      // so it can only run on the host. Pin it before target/node resolution so a
      // sandbox default or auto-selected browser node never receives the request.
      if (action === "importprofile") {
        if (target === "sandbox" || target === "node" || requestedNode) {
          throw new Error(
            'system profile import must run on the host; omit target or use target="host".',
          );
        }
        target = "host";
      }
      // existing-session profiles can attach through the selected host or browser node,
      // but they must never fall back into the sandbox browser.
      const isUserBrowserProfile = profileCapabilities?.usesChromeMcp === true;
      if (isUserBrowserProfile) {
        if (target === "sandbox") {
          throw new Error(
            `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
          );
        }
      }

      let nodeTarget: BrowserNodeTarget | null = null;
      try {
        nodeTarget = await resolveBrowserToolNodeTarget({
          requestedNode: requestedNode ?? undefined,
          profile: requestedProfile,
          target,
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
          allowHostControl: opts?.allowHostControl,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        // Keep the logged-in user browser usable on the host when auto-discovery
        // of browser nodes fails transiently. Explicit node requests still fail.
        if (!(isUserBrowserProfile && !target && !requestedNode && !configuredNode)) {
          throw error;
        }
      }
      if (isUserBrowserProfile && !target && !requestedNode && !nodeTarget) {
        target = "host";
      }

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const allowAutomaticHostFallback = Boolean(
        nodeTarget &&
        !target &&
        !requestedNode &&
        !configuredNode &&
        opts?.allowHostControl !== false,
      );
      const proxyRequest = nodeTarget
        ? createBrowserNodeProxyRequest({ nodeTarget, allowAutomaticHostFallback, signal })
        : null;
      if (proxyRequest) {
        // The node resolves omissions against its own config; Gateway defaults
        // never cross this execution-owner boundary.
        profile = requestedProfile;
      }
      if (
        !proxyRequest &&
        isUserBrowserProfile &&
        ["requests", "errors", "text", "emulate"].includes(action)
      ) {
        throw new Error(
          `action=${action} is not supported for existing-session profiles; use action=snapshot to inspect this page, or select a managed browser profile for ${action}.`,
        );
      }
      const nodeRoute = nodeTarget ? createBrowserNodeSessionTabRoute(nodeTarget) : undefined;
      const toolTimeoutMs = resolveBrowserToolTimeoutMs({
        requestedTimeoutMs,
        action,
        isUserBrowserProfile,
        usesPersistentPlaywright: profileCapabilities?.usesPersistentPlaywright === true,
        isNodeProxy: proxyRequest !== null,
        resolvedBrowser,
      });
      const sessionTabs = createBrowserToolSessionTabs({
        sessionKey: opts?.agentSessionKey,
        requestedProfile: profile,
        defaultProfile: resolvedBrowser.defaultProfile,
        baseUrl,
        nodeRoute,
        routeProfile: () => {
          const route = proxyRequest?.route();
          return route?.status === "resolved" ? route.profile : undefined;
        },
        isHostFallbackActive: proxyRequest?.isHostFallbackActive,
        registry: { touchSessionBrowserTab, trackSessionBrowserTab, untrackSessionBrowserTab },
      });
      switch (action) {
        case "doctor":
        case "status":
        case "start":
        case "stop":
        case "profiles":
        case "importprofile":
          return await executeBrowserLifecycleAction({
            action,
            input: params,
            baseUrl,
            profile,
            timeoutMs: toolTimeoutMs,
            proxyRequest,
            allowHostControl: opts?.allowHostControl,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            signal,
          });
        default:
          break;
      }
      let tabIdentity: BrowserTabIdentity | undefined;
      if (browserDashboard) {
        await assertBrowserDashboardTargetCurrent(browserDashboard, opts?.agentId, { signal });
      }
      const dispatchTabAction = () =>
        executeBrowserTabAction({
          action,
          actRequest: action === "act" ? readActRequestParam(params) : undefined,
          params,
          baseUrl,
          profile,
          proxyRequest,
          nodeRoute,
          sessionTabs,
          capabilities,
          isUserBrowserProfile,
          toolTimeoutMs,
          requestedTimeoutMs,
          signal,
          opts,
          boundTargetId: binding
            ? binding.targetId
            : dashboardName
              ? readStringParam(params, "targetId")
              : undefined,
          onTabActivity: (targetId, openedProfile) => {
            // Record the executed tab before follow-up observation adds page state.
            const route = proxyRequest?.route();
            const onNode = proxyRequest && !proxyRequest.isHostFallbackActive();
            const routeProfile = onNode
              ? route?.status === "resolved"
                ? route.profile
                : undefined
              : (profile ?? resolvedBrowser.defaultProfile);
            tabIdentity = resolveBrowserTabIdentity({
              targetId,
              baseUrl,
              profile: openedProfile ?? routeProfile,
              target: onNode ? "node" : "host",
              node: onNode && route?.status === "resolved" ? nodeTarget?.nodeId : undefined,
            });
          },
        });
      const dashboardTarget = browserDashboard;
      const result = dashboardTarget
        ? await withBrowserRequestScope(
            {
              managedOnly: true,
              assertCurrent: (admittedProfile) =>
                assertBrowserDashboardTargetCurrent(
                  dashboardTarget,
                  opts?.agentId,
                  { signal },
                  admittedProfile,
                ),
            },
            dispatchTabAction,
          )
        : await dispatchTabAction();
      if (browserDashboard) {
        // Dashboard presentation owns this tab; ordinary preview metadata would steal its panel.
        return { ...result, details: { ...asNullableRecord(result.details), browserDashboard } };
      }
      return [
        "open",
        "focus",
        "navigate",
        "screenshot",
        "snapshot",
        "text",
        "requests",
        "errors",
        "console",
        "emulate",
        "act",
      ].includes(action)
        ? withBrowserTabDetails(result, tabIdentity)
        : result;
    },
  };
}
