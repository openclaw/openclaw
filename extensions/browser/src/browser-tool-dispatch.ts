/** Browser tab action dispatch. Execution routing is prepared once by the tool owner. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import {
  type createBrowserToolSessionTabs,
  stripBrowserOpenInternalMetadata,
} from "./browser-tool-session-tabs.js";
import {
  executeActAction,
  executeConsoleAction,
  executeDownloadAction,
  executeEmulateAction,
  executeDebugLogAction,
  executeTextAction,
  executeTabsAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
import {
  type BrowserToolCapabilities,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  jsonResult,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveExistingUploadPaths,
} from "./browser-tool.runtime.js";
import {
  executeScreenshotAction,
  type BrowserScreenshotOptions,
} from "./browser-tool.screenshot.js";
import { appendNavigatedPageState, executeSnapshotAction } from "./browser-tool.snapshot.js";
import { parseBrowserNavigationUrl } from "./browser/navigation-guard.js";

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

/** Run tab actions against the prepared host, node, or sandbox route. */
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
  onTabActivity: (targetId: string | undefined, openedProfile?: string) => void;
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
  const touchTab = (targetId: string | undefined) => {
    sessionTabs.touch(targetId);
    context.onTabActivity(targetId);
  };
  const trackedTabResult = (result: unknown, targetId?: string) => {
    touchTab(readStringValue(asNullableRecord(result)?.targetId) ?? targetId);
    return jsonResult(result);
  };
  const actionOptions = { input: params, baseUrl, profile, proxyRequest, signal };
  const clientOptions = { profile, timeoutMs: toolTimeoutMs, signal };
  switch (action) {
    case "tabs":
      return await executeTabsAction({
        baseUrl,
        profile,
        timeoutMs: toolTimeoutMs,
        proxyRequest,
        targetId: context.boundTargetId,
        signal,
      });
    case "open": {
      const targetUrl = readTargetUrlParam(params);
      const label = normalizeOptionalString(params.label);
      const opened = await browserOpenTab(proxyRequest ?? baseUrl, targetUrl, {
        ...clientOptions,
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
      context.onTabActivity(
        readStringValue(asNullableRecord(opened)?.targetId),
        readStringValue(asNullableRecord(opened)?.resolvedProfile),
      );
      return formatBrowserExternalToolResult({
        kind: "tabs",
        payload: stripBrowserOpenInternalMetadata(opened),
      });
    }
    case "focus": {
      const targetId = readStringParam(params, "targetId", {
        required: true,
      });
      const result = await browserFocusTab(proxyRequest ?? baseUrl, targetId, clientOptions);
      return trackedTabResult(result, targetId);
    }
    case "close": {
      const targetId = readStringParam(params, "targetId");
      const result = targetId
        ? await browserCloseTab(proxyRequest ?? baseUrl, targetId, clientOptions)
        : await browserAct(proxyRequest ?? baseUrl, { kind: "close" }, clientOptions);
      sessionTabs.untrack(readStringValue(asNullableRecord(result)?.targetId) ?? targetId);
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
      const result = await browserNavigate(proxyRequest ?? baseUrl, {
        url: targetUrl,
        targetId,
        timeoutMs: requestedTimeoutMs,
        profile,
        signal,
      });
      const navigatedTargetId = readStringValue(asNullableRecord(result)?.targetId) ?? targetId;
      touchTab(navigatedTargetId);
      const formatted = formatBrowserExternalToolResult({
        kind: asNullableRecord(result)?.download ? "download" : "act",
        payload: result,
      });
      // A navigation that resolved to a download leaves the document
      // unchanged, so inline page state would describe the wrong thing.
      if (asNullableRecord(result)?.download) {
        return formatted;
      }
      return await appendNavigatedPageState({
        result: formatted,
        targetId: navigatedTargetId,
        baseUrl,
        profile,
        proxyRequest,
        signal,
      });
    }
    case "console": {
      const result = await executeConsoleAction(actionOptions);
      const targetId = readStringParam(params, "targetId");
      const canonicalTargetId = readStringValue(asNullableRecord(result.details)?.targetId);
      touchTab(canonicalTargetId ?? targetId);
      return result;
    }
    case "requests":
    case "errors":
    case "text":
    case "emulate": {
      const result =
        action === "requests" || action === "errors"
          ? await executeDebugLogAction(action, actionOptions)
          : await (action === "text" ? executeTextAction : executeEmulateAction)(actionOptions);
      touchTab(
        readStringValue(asNullableRecord(result.details)?.targetId) ??
          readStringValue(params.targetId),
      );
      return result;
    }
    case "pdf": {
      const targetId = normalizeOptionalString(params.targetId);
      const result = await browserPdfSave(proxyRequest ?? baseUrl, { targetId, profile, signal });
      touchTab(readStringValue(result.targetId) ?? targetId);
      return {
        content: [{ type: "text" as const, text: `FILE:${result.path}` }],
        details: result,
      };
    }
    case "download":
    case "waitfordownload":
      return await executeDownloadAction({
        ...actionOptions,
        action,
        onTabActivity: touchTab,
      });
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
      return trackedTabResult(
        await browserArmFileChooser(proxyRequest ?? baseUrl, {
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
      return trackedTabResult(
        await browserArmDialog(proxyRequest ?? baseUrl, { ...request, profile, signal }),
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
      return await executeActAction({
        request,
        baseUrl,
        profile,
        usesChromeMcp: isUserBrowserProfile,
        proxyRequest,
        signal,
        onTabActivity: touchTab,
        onTabClose: sessionTabs.untrack,
      });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
