import type { CodexPluginInventoryRecord, CodexPluginBridgeRequest } from "./plugin-inventory.js";
import type { v2 } from "./protocol-generated/typescript/index.js";

export type CodexPluginActivationStatus =
  | { status: "disabled" }
  | { status: "not_migrated" }
  | { status: "marketplace_missing"; message: string }
  | { status: "auth_required"; appsNeedingAuth: v2.AppSummary[] }
  | { status: "ready"; installed: boolean };

export async function ensureCodexPluginActivated(params: {
  request: CodexPluginBridgeRequest;
  record: CodexPluginInventoryRecord;
}): Promise<CodexPluginActivationStatus> {
  const record = params.record;
  if (!record.enabledInOpenClaw) {
    return { status: "disabled" };
  }
  if (!record.sourceInstalled) {
    return { status: "not_migrated" };
  }
  if (record.installed && record.enabledInCodex && !record.authRequired) {
    return { status: "ready", installed: false };
  }
  if (!record.marketplacePath) {
    return {
      status: "marketplace_missing",
      message: `Codex marketplace path for ${record.marketplaceName} is unavailable.`,
    };
  }
  const installed = (await params.request("plugin/install", {
    marketplacePath: record.marketplacePath,
    pluginName: record.pluginName,
  } satisfies v2.PluginInstallParams)) as v2.PluginInstallResponse;
  await refreshCodexPluginRuntimeState(params.request);
  if (installed.appsNeedingAuth.length > 0) {
    return { status: "auth_required", appsNeedingAuth: installed.appsNeedingAuth };
  }
  return { status: "ready", installed: true };
}

export async function refreshCodexPluginRuntimeState(
  request: CodexPluginBridgeRequest,
): Promise<void> {
  await request("plugin/list", {});
  await request("skills/list", { forceReload: true });
  await request("hooks/list", {});
  await request("config/mcpServer/reload", undefined);
  await request("mcpServerStatus/list", { detail: true });
  await request("app/list", { forceRefetch: true });
}
