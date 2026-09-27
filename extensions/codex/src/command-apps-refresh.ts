import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerPrewriteRequestCancellationError,
} from "./app-server/client.js";
import { refreshCodexAppRuntimeState } from "./app-server/plugin-activation.js";
import type { CodexAppServerRequestResult } from "./app-server/protocol.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  describeCodexHostedAppsSupport,
  formatBoundAccount,
  readCodexHostedAppsSupport,
} from "./command-plugins-readiness.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";

/** Refreshes hosted app inventory for the current account/runtime. */
export async function refreshCodexHostedApps(
  context: CodexPluginCommandContext,
): Promise<PluginCommandResult> {
  let account: CodexAppServerRequestResult<"account/read">;
  try {
    account = await context.request("account/read", { refreshToken: false });
    // The refresh has no threadId. Check the same runtime-wide feature state,
    // without using a selected plugin's policy as permission to refresh apps.
    const support = await readCodexHostedAppsSupport(
      { request: context.request },
      { status: "known", value: account },
    );
    if (support !== "supported") {
      return {
        text: `Hosted app inventory was not refreshed. ${describeCodexHostedAppsSupport(support)}`,
      };
    }
    await refreshCodexAppRuntimeState({
      request: context.request,
      appCache: defaultCodexAppInventoryCache,
      appCacheKey: context.appCacheKey,
    });
  } catch (error) {
    // Scope changes take precedence over a transport failure from the old account.
    await context.validateCurrent();
    const reason =
      error instanceof CodexAppServerRpcError && error.code === -32601
        ? "This Codex app-server does not support the required app inventory methods. Update the Codex plugin and retry."
        : (isCodexAppServerIndeterminateRequestCancellationError(error) ||
              isCodexAppServerPrewriteRequestCancellationError(error)) &&
            "reason" in error &&
            error.reason === "aborted"
          ? "The hosted app refresh was cancelled."
          : "Hosted app tools could not be refreshed. Check the Codex connection and try again.";
    return {
      text: `${reason} Run /codex plugins refresh to retry for the current Codex account/runtime. Previous inventory was not confirmed; no conversation policy was changed.`,
    };
  }
  const presentation: MessagePresentation = {
    title: "Hosted app refresh",
    blocks: [
      {
        type: "text",
        text: [
          `Agent: ${formatCodexDisplayText(context.agentId.slice(0, 120))} · Profile: ${formatCodexDisplayText((context.profileId ?? "native Codex account (profile unknown)").slice(0, 120))}`,
          formatBoundAccount({ status: "known", value: account }),
          "Hosted app refresh request completed for the current Codex account/runtime, across all hosted apps. Codex does not report whether it replaced its snapshot; this does not verify a live connection. No plugin enablement or conversation policy was changed. Use /new or /reset after connecting.",
        ].join("\n"),
      },
      {
        type: "text",
        text: "Use /codex plugins list to find configured plugins, then /codex plugins status <name>@<marketplace> to inspect one.",
      },
    ],
  };
  return {
    text: renderMessagePresentationFallbackText({ presentation }),
    presentation,
    presentationTextMode: "fallback",
  };
}
