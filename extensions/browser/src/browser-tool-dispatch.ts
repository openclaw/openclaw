/** Browser tab action dispatch. Execution routing is prepared once by the tool owner. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import type { createBrowserToolSessionTabs } from "./browser-tool-session-tabs.js";
import { judgeBrowserPage } from "./browser-tool.judge.js";
import type { BrowserToolCapabilities } from "./browser-tool.schema.js";
import {
  executeScreenshotAction,
  type BrowserScreenshotOptions,
} from "./browser-tool.screenshot.js";
import {
  appendNavigatedPageState,
  executeSnapshotAction,
  formatBrowserDebugLogResult,
  wrapBrowserExternalJson,
  wrapBrowserExternalText,
} from "./browser-tool.snapshot.js";
import { BROWSER_ACT_KIND_FACTS } from "./browser/act-kinds.js";
import type { BrowserActionOk } from "./browser/client-actions-types.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserNavigate,
  browserPdfSave,
  browserConsoleMessages,
  browserRequests,
  browserErrors,
  browserPageText,
  browserEmulateSetting,
  browserDownload,
  browserWaitForDownload,
} from "./browser/client-actions.js";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserTabs,
  type BrowserTab,
  type BrowserTabsResult,
} from "./browser/client.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "./browser/constants.js";
import { parseBrowserNavigationUrl } from "./browser/navigation-guard.js";
import { resolveExistingUploadPaths } from "./browser/paths.js";

type BrowserActRequest = Parameters<typeof browserAct>[1];
type BrowserActResponse = Awaited<ReturnType<typeof browserAct>>;

function normalizePositiveTimeoutMs(value: unknown): number | undefined {
  return readPositiveIntegerParam({ value }, "value", {
    message: "timeoutMs must be a positive integer.",
  });
}

function normalizeNonNegativeDurationMs(value: unknown): number | undefined {
  return readNonNegativeIntegerParam({ value }, "value", {
    message: "timeMs must be a non-negative integer.",
  });
}

function withLocalActTimeout(
  request: BrowserActRequest,
  usesChromeMcp: boolean,
): BrowserActRequest {
  const facts = BROWSER_ACT_KIND_FACTS[request.kind];
  if (
    ("timeoutMs" in request && request.timeoutMs !== undefined) ||
    (usesChromeMcp && !facts?.existingSessionTimeout) ||
    facts?.timeout !== "default"
  ) {
    return request;
  }
  const timedRequest = { ...request, timeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS };
  return timedRequest;
}

function formatAgentTab(source: BrowserTab): Record<string, unknown> {
  const targetId = readStringValue(source.targetId);
  const tabId = readStringValue(source.tabId);
  const webExtensionTabId = source.webExtensionTabId;
  const label = readStringValue(source.label);
  const suggestedTargetId = readStringValue(source.suggestedTargetId) ?? label ?? tabId ?? targetId;
  return {
    ...(suggestedTargetId ? { suggestedTargetId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(webExtensionTabId !== undefined ? { webExtensionTabId } : {}),
    ...(label ? { label } : {}),
    title: source.title,
    url: source.url,
    ...(source.urlUnavailableReason ? { urlUnavailableReason: source.urlUnavailableReason } : {}),
    type: source.type,
    ...(targetId ? { targetId } : {}),
    ...(source.wsUrl ? { wsUrl: source.wsUrl } : {}),
  };
}

/** Protect page-controlled model text while preserving the shipped structured result contract. */
function formatBrowserExternalToolResult(params: {
  kind: "act" | "download" | "tabs";
  payload: unknown;
}): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: params.kind,
    payload: params.payload,
    includeWarning: false,
  });
  // The Browser tool already marks the turn as network-tainted, and replay
  // strips details; changing this public structured payload breaks callers.
  return textResult(wrapped.wrappedText, params.payload);
}

function isChromeStaleTargetError(usesChromeMcp: boolean, err: unknown): boolean {
  const status = err && typeof err === "object" && "status" in err ? err.status : null;
  const msg = String(err);
  const isTabNotFound = (status === 404 || msg.includes("404:")) && msg.includes("tab not found");
  return usesChromeMcp && isTabNotFound;
}

function canRetryChromeActAfterSoleTargetRefresh(request: BrowserActRequest): boolean {
  if (request.kind !== "wait" || normalizeNonNegativeDurationMs(request.timeMs) === undefined) {
    return false;
  }
  return [
    request.fn,
    request.text,
    request.textGone,
    request.selector,
    request.url,
    request.loadState,
  ].every((value) => !normalizeOptionalString(value));
}

function actObservedNavigation(result: BrowserActResponse): boolean {
  return (
    result.aborted?.reason === "navigation" ||
    result.results?.some((entry) => entry.navigated === true) === true
  );
}

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = normalizeOptionalString(params.targetId);
  const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  const targetUrl =
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" });
  parseBrowserNavigationUrl(targetUrl);
  return targetUrl;
}

export async function executeBrowserTabAction(context: {
  action: string;
  actRequest?: Parameters<typeof browserAct>[1];
  params: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  nodeRoute?: Parameters<typeof createBrowserToolSessionTabs>[0]["nodeRoute"];
  sessionTabs: ReturnType<typeof createBrowserToolSessionTabs>;
  capabilities: BrowserToolCapabilities;
  isUserBrowserProfile: boolean;
  boundTargetId?: string;
  toolTimeoutMs?: number;
  requestedTimeoutMs?: number;
  signal?: AbortSignal;
  opts?: BrowserScreenshotOptions;
  judgment?: { decisions: DecisionRuntimeV2; agentId: string };
  onTabActivity: (targetId: string | undefined, openedProfile?: string) => void | Promise<void>;
}): Promise<AgentToolResult<unknown>> {
  const {
    action,
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
  } = context;
  const touchTab = async (targetId: string | undefined) => {
    await sessionTabs.touch(targetId);
    await context.onTabActivity(targetId);
  };
  const trackedTabResult = async (
    result: BrowserActionOk & { targetId?: string },
    targetId?: string,
  ) => {
    await touchTab(readStringValue(result.targetId) ?? targetId);
    return jsonResult(result);
  };
  const target = proxyRequest ?? baseUrl;
  const actionOptions = { input: params, target, profile, signal };
  const clientOptions = { profile, timeoutMs: toolTimeoutMs, signal };
  async function executeTabsAction(): Promise<AgentToolResult<unknown>> {
    const result = await browserTabs(target, {
      profile,
      timeoutMs: toolTimeoutMs,
      signal,
    });
    const tabs = result.tabs.filter(
      (tab) => !context.boundTargetId || readStringValue(tab.targetId) === context.boundTargetId,
    );
    const running = result.running;
    const formattedTabs = tabs.map(formatAgentTab);
    const wrapped = wrapBrowserExternalJson({
      kind: "tabs",
      payload: { running, tabs: formattedTabs },
      includeWarning: false,
    });
    return textResult(wrapped.wrappedText, {
      ...wrapped.safeDetails,
      running,
      tabCount: formattedTabs.length,
      tabs: formattedTabs,
    });
  }

  async function executeConsoleAction(): Promise<AgentToolResult<unknown>> {
    const result = await browserConsoleMessages(target, {
      level: normalizeOptionalString(params.level),
      targetId: normalizeOptionalString(params.targetId),
      profile,
      signal,
    });
    const wrapped = wrapBrowserExternalJson({
      kind: "console",
      payload: result,
      includeWarning: false,
    });
    return textResult(wrapped.wrappedText, {
      ...wrapped.safeDetails,
      targetId: readStringValue(result.targetId),
      url: readStringValue(result.url),
      messageCount: result.messages.length,
    });
  }

  /** Read browser debug logs, keeping counts aligned with the bounded payload. */
  async function executeDebugLogAction(
    kind: "requests" | "errors",
  ): Promise<AgentToolResult<unknown>> {
    const limit =
      readPositiveIntegerParam(params, "limit", { message: "limit must be a positive integer." }) ??
      50;
    const options = {
      targetId: normalizeOptionalString(params.targetId),
      clear: typeof params.clear === "boolean" ? params.clear : undefined,
      profile,
      signal,
    };
    if (kind === "requests") {
      const result = await browserRequests(target, {
        ...options,
        filter: normalizeOptionalString(params.filter),
      });
      return formatBrowserDebugLogResult(kind, result, result.requests, limit);
    }
    const result = await browserErrors(target, options);
    return formatBrowserDebugLogResult("errors", result, result.errors, limit);
  }

  /** Extract visible page prose with the same trust boundary as snapshots. */
  async function executeTextAction(): Promise<AgentToolResult<unknown>> {
    const targetId = normalizeOptionalString(params.targetId);
    const selector = normalizeOptionalString(params.selector);
    const maxChars = Math.min(
      readPositiveIntegerParam(params, "maxChars", {
        message: "maxChars must be a positive integer.",
      }) ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    );
    const result = await browserPageText(target, {
      targetId,
      selector,
      maxChars,
      profile,
      signal,
    });
    const wrapped = wrapBrowserExternalText({
      value: result.text,
      marker: "\n[truncated — retry with a narrower selector]",
      includeWarning: true,
      maxChars,
      prefix: result.truncated
        ? "Page text was truncated. Retry with a narrower selector."
        : undefined,
    });
    return textResult(wrapped.text, {
      ok: result.ok,
      text: wrapped.text,
      targetId: result.targetId,
      url: result.url,
      truncated: result.truncated || wrapped.truncated,
      externalContent: { untrusted: true, source: "browser", kind: "text", wrapped: true },
    });
  }

  /** Apply settings in order and pin later changes to the first resolved tab. */
  async function executeEmulateAction(): Promise<AgentToolResult<unknown>> {
    const settings = [
      ["device", "device", "name"],
      ["colorScheme", "media", "colorScheme"],
      ["timezoneId", "timezone", "timezoneId"],
      ["locale", "locale", "locale"],
    ] as const;
    const requested = settings.flatMap(([field, setting, key]) => {
      const value = normalizeOptionalString(params[field]);
      return value ? [{ field, setting, key, value }] : [];
    });
    if (requested.length === 0) {
      throw new Error(
        "emulate requires at least one of device, colorScheme, timezoneId, or locale.",
      );
    }
    const colorScheme = requested.find(({ field }) => field === "colorScheme")?.value;
    if (colorScheme && !["dark", "light", "no-preference", "none"].includes(colorScheme)) {
      throw new Error("colorScheme must be dark|light|no-preference|none.");
    }
    let targetId = normalizeOptionalString(params.targetId);
    for (const { setting, key, value } of requested) {
      const body = { targetId, [key]: value };
      const result = await browserEmulateSetting(target, {
        setting,
        body,
        profile,
        signal,
      });
      targetId = result.targetId ?? targetId;
    }
    return jsonResult({ ok: true, targetId, applied: requested.map(({ field }) => field) });
  }

  async function executeDownloadAction(): Promise<AgentToolResult<unknown>> {
    const targetId = normalizeOptionalString(params.targetId);
    const timeoutMs = normalizePositiveTimeoutMs(params.timeoutMs);
    const options = { targetId, timeoutMs, profile, signal };
    const result =
      action === "download"
        ? await browserDownload(target, {
            ...options,
            ref: readStringParam(params, "ref", { required: true }),
            path: readStringParam(params, "path", { required: true }),
          })
        : await browserWaitForDownload(target, {
            ...options,
            path: readStringParam(params, "path"),
          });
    await touchTab(readStringValue(result.targetId) ?? targetId);
    return formatBrowserExternalToolResult({ kind: "download", payload: result });
  }

  /** Execute browser actions with route-owned timeout semantics and stale-tab recovery. */
  async function executeActAction(request: BrowserActRequest): Promise<AgentToolResult<unknown>> {
    if ("timeoutMs" in request && request.timeoutMs !== undefined) {
      normalizePositiveTimeoutMs(request.timeoutMs);
    }
    const effectiveRequest = proxyRequest
      ? request
      : withLocalActTimeout(request, isUserBrowserProfile);
    // resolvedTargetId is the id the act actually ran against (retry paths swap
    // it), so page-state capture must use it rather than the original request's.
    const finishActResult = async (
      result: BrowserActResponse,
      resolvedTargetId: string | undefined,
    ) => {
      const aborted = result.aborted;
      const onTabResult =
        effectiveRequest.kind === "close" || aborted?.reason === "closed"
          ? sessionTabs.untrack
          : touchTab;
      await onTabResult(resolvedTargetId);
      let formatted = formatBrowserExternalToolResult({ kind: "act", payload: result });
      if (aborted) {
        // Navigation aborts get fresh page state (or an unavailable hint) appended by
        // finishActResult, so only the closed case tells the model to snapshot manually.
        const note =
          aborted.reason === "navigation"
            ? `Batch aborted after action ${aborted.afterAction} because the page navigated; ${aborted.skipped} remaining action(s) skipped. Earlier refs are stale.`
            : `Batch aborted after action ${aborted.afterAction} because the page or browser context closed; ${aborted.skipped} remaining action(s) skipped. Take a new snapshot before continuing.`;
        formatted = {
          ...formatted,
          content: [...formatted.content, { type: "text", text: note }],
        };
      }
      if (!actObservedNavigation(result)) {
        return formatted;
      }
      // Batch aborts snapshot at navigation commit, so a slow page can still be
      // loading; the model may need one follow-up snapshot for late content.
      return await appendNavigatedPageState({
        result: formatted,
        targetId: resolvedTargetId,
        target: proxyRequest ?? baseUrl,
        profile,
        signal,
      });
    };
    const dispatchAct = async (actionRequest: BrowserActRequest) => {
      const result = await browserAct(proxyRequest ?? baseUrl, actionRequest, {
        profile,
        signal,
      });
      return {
        result,
        targetId: readStringValue(result.targetId) ?? readStringValue(actionRequest.targetId),
      };
    };
    let dispatched: Awaited<ReturnType<typeof dispatchAct>>;
    try {
      dispatched = await dispatchAct(effectiveRequest);
    } catch (err) {
      const proxyRoute = proxyRequest?.route();
      const usesChromeMcp = proxyRequest
        ? proxyRoute?.status === "resolved" && proxyRoute.driver === "existing-session"
        : isUserBrowserProfile;
      const recoveryProfile =
        proxyRoute?.status === "resolved" ? proxyRoute.profile : (profile ?? "default");
      if (isChromeStaleTargetError(usesChromeMcp, err)) {
        let tabRefreshError: unknown;
        const availability = await browserTabs(proxyRequest ?? baseUrl, {
          profile,
          signal,
        }).catch((refreshError: unknown): BrowserTabsResult => {
          signal?.throwIfAborted();
          tabRefreshError = refreshError;
          return { running: false, tabs: [] };
        });
        const tabs = availability.tabs;
        const freshTargetId = tabs.length === 1 ? readStringValue(tabs[0]?.targetId) : undefined;
        const retryRequest =
          freshTargetId && normalizeOptionalString(effectiveRequest.targetId)
            ? { ...effectiveRequest, targetId: freshTargetId }
            : null;
        // This is same-agent continuity, not identity recovery: only target-independent
        // waits may retry, against the one freshly listed tab. Ref-scoped and scripted
        // operations require explicit fresh selection (and a fresh snapshot for refs).
        if (retryRequest && canRetryChromeActAfterSoleTargetRefresh(effectiveRequest)) {
          const retried = await dispatchAct(retryRequest);
          return await finishActResult(retried.result, retried.targetId);
        }
        if (tabRefreshError) {
          throw new Error(
            `Chrome tab not found for profile="${recoveryProfile}", and refreshing tabs failed: ${formatErrorMessage(tabRefreshError)}. Run action=tabs profile="${recoveryProfile}" and retry with a returned targetId.`,
            { cause: err },
          );
        }
        if (!availability.running) {
          throw new Error(
            `Browser tabs are unavailable for profile="${recoveryProfile}". Reconnect or start that browser profile, then run action=tabs and retry.`,
            { cause: err },
          );
        }
        if (!tabs.length) {
          throw new Error(
            `No browser tabs found for profile="${recoveryProfile}". Make sure the configured Chromium-based browser (v144+) is running and has open tabs, then retry.`,
            { cause: err },
          );
        }
        throw new Error(
          `Chrome tab not found (stale targetId?). Run action=tabs profile="${recoveryProfile}" and use one of the returned targetIds.`,
          { cause: err },
        );
      }
      throw err;
    }
    return await finishActResult(dispatched.result, dispatched.targetId);
  }
  switch (action) {
    case "tabs":
      return await executeTabsAction();
    case "open": {
      const targetUrl = readTargetUrlParam(params);
      const label = normalizeOptionalString(params.label);
      const opened = await browserOpenTab(target, targetUrl, {
        ...clientOptions,
        timeoutMs: requestedTimeoutMs,
        requestTimeoutMs: requestedTimeoutMs === undefined ? toolTimeoutMs : undefined,
        label,
      });
      const closeOpenedTab = async (targetId: string, openedProfile?: string) => {
        if (nodeRoute && !proxyRequest?.isHostFallbackActive()) {
          await nodeRoute.closeTarget({ targetId, profile: openedProfile });
          return;
        }
        await browserCloseTab(baseUrl, targetId, {
          profile: openedProfile,
          timeoutMs: toolTimeoutMs,
        });
      };
      await sessionTabs.trackOpened(opened, closeOpenedTab);
      await context.onTabActivity(
        readStringValue(opened.targetId),
        readStringValue(opened.resolvedProfile),
      );
      const { ownership: _ownership, resolvedProfile: _resolvedProfile, ...agentVisible } = opened;
      return formatBrowserExternalToolResult({
        kind: "tabs",
        payload: agentVisible,
      });
    }
    case "focus": {
      const targetId = readStringParam(params, "targetId", {
        required: true,
      });
      const result = await browserFocusTab(target, targetId, clientOptions);
      return await trackedTabResult(result, targetId);
    }
    case "close": {
      const targetId = readStringParam(params, "targetId");
      const result = targetId
        ? await browserCloseTab(target, targetId, clientOptions)
        : await browserAct(target, { kind: "close" }, clientOptions);
      await sessionTabs.untrack(readStringValue(result.targetId) ?? targetId);
      return jsonResult(result);
    }
    case "snapshot":
      return await executeSnapshotAction({
        ...actionOptions,
        onTabActivity: touchTab,
      });
    case "screenshot":
      return await executeScreenshotAction({
        ...actionOptions,
        requestedTimeoutMs,
        onTabActivity: touchTab,
        opts,
      });
    case "navigate": {
      const targetUrl = readTargetUrlParam(params);
      const targetId = readStringParam(params, "targetId");
      const result = await browserNavigate(target, {
        url: targetUrl,
        targetId,
        timeoutMs: requestedTimeoutMs,
        profile,
        signal,
      });
      const navigatedTargetId = readStringValue(result.targetId) ?? targetId;
      await touchTab(navigatedTargetId);
      const formatted = formatBrowserExternalToolResult({
        kind: result.download ? "download" : "act",
        payload: result,
      });
      // A navigation that resolved to a download leaves the document
      // unchanged, so inline page state would describe the wrong thing.
      if (result.download) {
        return formatted;
      }
      return await appendNavigatedPageState({
        result: formatted,
        targetId: navigatedTargetId,
        target,
        profile,
        signal,
      });
    }
    case "console": {
      const result = await executeConsoleAction();
      const targetId = readStringParam(params, "targetId");
      const canonicalTargetId = readStringValue(asNullableRecord(result.details)?.targetId);
      await touchTab(canonicalTargetId ?? targetId);
      return result;
    }
    case "judge": {
      if (!context.judgment) {
        throw new Error("Browser judgment requires this agent's bound Decision runtime.");
      }
      const result = await judgeBrowserPage({
        target,
        targetId: normalizeOptionalString(params.targetId),
        profile,
        signal,
        ...context.judgment,
      });
      await touchTab(result.targetId);
      const wrapped = wrapBrowserExternalJson({ kind: "judge", payload: result });
      return textResult(wrapped.wrappedText, { ...wrapped.safeDetails, ...result });
    }
    case "requests":
    case "errors":
    case "text":
    case "emulate": {
      const result =
        action === "requests" || action === "errors"
          ? await executeDebugLogAction(action)
          : await (action === "text" ? executeTextAction : executeEmulateAction)();
      await touchTab(
        readStringValue(asNullableRecord(result.details)?.targetId) ??
          readStringValue(params.targetId),
      );
      return result;
    }
    case "pdf": {
      const targetId = normalizeOptionalString(params.targetId);
      const result = await browserPdfSave(target, { targetId, profile, signal });
      await touchTab(readStringValue(result.targetId) ?? targetId);
      return textResult(`FILE:${result.path}`, result);
    }
    case "download":
    case "waitfordownload":
      return await executeDownloadAction();
    case "upload": {
      const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
      if (paths.length === 0) {
        throw new Error("paths required");
      }
      const resolvedResult = await resolveExistingUploadPaths({ requestedPaths: paths });
      if (!resolvedResult.ok) {
        throw new Error(resolvedResult.error);
      }
      const ref = readStringParam(params, "ref");
      const inputRef = readStringParam(params, "inputRef");
      const element = readStringParam(params, "element");
      const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
      return await trackedTabResult(
        await browserArmFileChooser(target, {
          paths: resolvedResult.paths,
          ref,
          inputRef,
          element,
          targetId,
          timeoutMs,
          profile,
          signal,
        }),
        targetId,
      );
    }
    case "dialog": {
      const accept = Boolean(params.accept);
      const promptText = readStringValue(params.promptText);
      const dialogId = readStringValue(params.dialogId);
      const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
      const request = { accept, promptText, dialogId, targetId, timeoutMs };
      return await trackedTabResult(
        await browserArmDialog(target, { ...request, profile, signal }),
        targetId,
      );
    }
    case "act": {
      const request = context.actRequest;
      if (!request) {
        throw new Error("request required");
      }
      if (!capabilities.actKinds.some((kind) => kind === request.kind)) {
        throw new Error(
          `browser act kind ${JSON.stringify(request.kind)} is unavailable for this run`,
        );
      }
      return await executeActAction(request);
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
