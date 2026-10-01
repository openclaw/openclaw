import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { codexAppIdentityKey } from "./app-identity.js";
import type { CodexActiveMcpToolCall } from "./event-projector-native-tool-lifecycle.js";
import type {
  CodexAppPolicyContextEntry,
  PluginAppPolicyContext,
  PluginAppPolicyContextEntry,
} from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

type PluginElicitationResolution =
  | { kind: "not_plugin" }
  | {
      kind: "matched";
      entry: CodexAppPolicyContextEntry;
      appId?: string;
      verifiedToolName?: string;
      verifiedMcpServer?: string;
    }
  | { kind: "decline"; reason: string };

const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";
const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY = "connector_name";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = "tool_params_display";
const MCP_TOOL_APPROVAL_SOURCE_KEY = "source";
const MCP_TOOL_APPROVAL_CONNECTOR_SOURCE = "connector";
const CODEX_APPS_SERVER_NAME = "codex_apps";
const PLUGIN_APP_ID_META_KEYS = ["app_id", "appId", "codex_app_id", "codexAppId"];
const PLUGIN_CONNECTOR_ID_META_KEYS = ["connector_id", "connectorId"];
const PLUGIN_NAME_META_KEYS = ["plugin_name", "pluginName", "codex_plugin_name", "codexPluginName"];
const PLUGIN_CONFIG_KEY_META_KEYS = ["config_key", "configKey", "codex_config_key"];
const PLUGIN_MARKETPLACE_NAME_META_KEYS = [
  "marketplace_name",
  "marketplaceName",
  "codex_marketplace_name",
  "codexMarketplaceName",
];
export function matchesMcpApprovalDisplay(item: CodexActiveMcpToolCall, meta: JsonObject): boolean {
  if (!Object.hasOwn(meta, MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY)) {
    return true;
  }
  const display = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY];
  if (!Array.isArray(display)) {
    return false;
  }
  const args = item.arguments;
  return display.every((param) => {
    if (!isJsonObject(param) || typeof param.name !== "string" || !isJsonObject(args)) {
      return false;
    }
    if (!Object.hasOwn(args, param.name)) {
      return false;
    }
    const value = args[param.name];
    return (
      typeof param.value !== "string" ||
      param.value === (typeof value === "string" ? value : JSON.stringify(value))
    );
  });
}

export function resolvePluginElicitation(params: {
  requestParams: JsonObject;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  getActiveMcpToolCall?: (
    serverName: string,
    connectorId?: string,
  ) => CodexActiveMcpToolCall | undefined;
}): PluginElicitationResolution {
  const requestParams = params.requestParams;
  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
  const context = params.pluginAppPolicyContext;
  const entries = context ? Object.values(context.apps) : [];
  const pluginEntries = entries.filter(isPluginAppPolicyContextEntry);

  const appId =
    readFirstString(meta, PLUGIN_APP_ID_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_APP_ID_META_KEYS);
  const connectorId = readFirstString(meta, PLUGIN_CONNECTOR_ID_META_KEYS);
  const isCodexConnectorApproval = isCodexConnectorApprovalElicitation(requestParams, meta);
  if (
    isCodexConnectorApproval &&
    appId &&
    connectorId &&
    codexAppIdentityKey(appId) !== codexAppIdentityKey(connectorId)
  ) {
    return { kind: "decline", reason: "app_id_connector_id_mismatch" };
  }
  const matchedAppId = appId ?? (isCodexConnectorApproval ? connectorId : undefined);
  if (matchedAppId) {
    if (!context) {
      return { kind: "decline", reason: "missing_policy_context" };
    }
    const matches = Object.entries(context.apps).filter(
      ([id]) => codexAppIdentityKey(id) === codexAppIdentityKey(matchedAppId),
    );
    if (matches.some(([, entry]) => entry.source === "account") && !isCodexConnectorApproval) {
      return { kind: "decline", reason: "account_app_source_mismatch" };
    }
    const resolution = uniquePluginMatch(
      matches.map(([, entry]) => entry),
      appId ? "app_id" : "connector_id",
    );
    if (resolution.kind !== "matched" || !isCodexConnectorApproval || !connectorId) {
      return resolution;
    }
    // Keep the admitted app key, even when Codex reports its Apps SDK alias.
    // Exact tool overrides use the catalog action, never the display title.
    const item = params.getActiveMcpToolCall?.(CODEX_APPS_SERVER_NAME, connectorId);
    return {
      ...resolution,
      appId: matches[0]?.[0],
      verifiedToolName:
        item && matchesMcpApprovalDisplay(item, meta)
          ? readNonBlankString(item.actionName)
          : undefined,
    };
  }

  const pluginName =
    readFirstString(meta, PLUGIN_NAME_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_NAME_META_KEYS);
  const configKey =
    readFirstString(meta, PLUGIN_CONFIG_KEY_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_CONFIG_KEY_META_KEYS);
  const marketplaceName =
    readFirstString(meta, PLUGIN_MARKETPLACE_NAME_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_MARKETPLACE_NAME_META_KEYS);
  if (pluginName || configKey) {
    if (!context) {
      return { kind: "decline", reason: "missing_policy_context" };
    }
    return uniquePluginMatch(
      pluginEntries.filter(
        (entry) =>
          (!marketplaceName || entry.marketplaceName === marketplaceName) &&
          (!pluginName || entry.pluginName === pluginName) &&
          (!configKey || entry.configKey === configKey),
      ),
      "metadata",
    );
  }

  if (context && hasDisplayNameOnlyPluginMatch(meta, entries)) {
    return { kind: "decline", reason: "display_name_only" };
  }

  return { kind: "not_plugin" };
}

export function resolvePluginMcpElicitation(params: {
  requestParams: JsonObject;
  serverName?: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  getActiveMcpToolCallAttribution?: (
    serverName: string,
  ) => (CodexActiveMcpToolCall & { pluginId: string | null }) | undefined;
}): PluginElicitationResolution {
  const { requestParams, serverName, pluginAppPolicyContext: context } = params;
  const serverOwners = context?.mcpServers;
  const hasServerOwner = Boolean(
    serverName && serverOwners && Object.hasOwn(serverOwners, serverName),
  );
  const item = serverName ? params.getActiveMcpToolCallAttribution?.(serverName) : undefined;
  if (item?.pluginId && !context?.nativePlugins) {
    return { kind: "decline", reason: "missing_policy_context" };
  }
  if (!context?.nativePlugins || item?.pluginId === null) {
    // An MCP server may claim a plugin app in its own metadata. Without trusted
    // server ownership, such a claim cannot select that app's reviewer policy.
    const claimed = resolvePluginElicitation({ requestParams, pluginAppPolicyContext: context });
    return claimed.kind === "not_plugin"
      ? claimed
      : { kind: "decline", reason: "unverified_plugin_server_owner" };
  }
  if (!item) {
    // Codex emits item/started before its approval request. Without a unique
    // active item, an unmapped plugin could inherit generic autoapproval.
    return { kind: "decline", reason: "unverified_mcp_tool_owner" };
  }
  const owner = Object.hasOwn(context.nativePlugins, item.pluginId)
    ? context.nativePlugins[item.pluginId]
    : undefined;
  if (!owner || (hasServerOwner && serverName && serverOwners?.[serverName] !== item.pluginId)) {
    return { kind: "decline", reason: "unverified_plugin_server_owner" };
  }
  const meta = isJsonObject(requestParams._meta) ? requestParams._meta : {};
  const claimedAppId =
    readFirstString(meta, PLUGIN_APP_ID_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_APP_ID_META_KEYS);
  if (claimedAppId) {
    const matches = Object.entries(context.apps)
      .filter(([id]) => codexAppIdentityKey(id) === codexAppIdentityKey(claimedAppId))
      .map(([, entry]) => entry);
    if (
      matches.length !== 1 ||
      !matches[0] ||
      !isPluginAppPolicyContextEntry(matches[0]) ||
      matches[0].configKey !== owner.configKey
    ) {
      return { kind: "decline", reason: "app_id_server_owner_mismatch" };
    }
  }
  if (!matchesMcpApprovalDisplay(item, meta)) {
    return { kind: "decline", reason: "unverified_plugin_tool_call" };
  }
  return {
    kind: "matched",
    entry: owner,
    verifiedToolName: item.tool,
    verifiedMcpServer: serverName,
  };
}

export function isCodexConnectorApprovalElicitation(
  requestParams: JsonObject,
  meta: JsonObject,
): boolean {
  return (
    readNonBlankString(requestParams.serverName) === CODEX_APPS_SERVER_NAME &&
    readNonBlankString(meta[MCP_TOOL_APPROVAL_KIND_KEY]) === MCP_TOOL_APPROVAL_KIND &&
    readNonBlankString(meta[MCP_TOOL_APPROVAL_SOURCE_KEY]) === MCP_TOOL_APPROVAL_CONNECTOR_SOURCE
  );
}

function uniquePluginMatch(
  matches: CodexAppPolicyContextEntry[],
  source: string,
): PluginElicitationResolution {
  if (matches.length === 1 && matches[0]) {
    return { kind: "matched", entry: matches[0] };
  }
  return {
    kind: "decline",
    reason: matches.length === 0 ? `${source}_not_enabled` : `${source}_ambiguous`,
  };
}

function hasDisplayNameOnlyPluginMatch(
  meta: JsonObject,
  entries: CodexAppPolicyContextEntry[],
): boolean {
  const connectorName = readNonBlankString(meta[MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY]);
  if (!connectorName) {
    return false;
  }
  const normalized = normalizePluginIdentityText(connectorName);
  return entries.some(
    (entry) =>
      normalizePluginIdentityText(appPolicyDisplayName(entry)) === normalized ||
      (isPluginAppPolicyContextEntry(entry) &&
        normalizePluginIdentityText(entry.configKey) === normalized),
  );
}

export function isPluginAppPolicyContextEntry(
  entry: CodexAppPolicyContextEntry,
): entry is PluginAppPolicyContextEntry {
  return entry.source !== "account";
}

export function appPolicyDisplayName(entry: CodexAppPolicyContextEntry): string {
  return isPluginAppPolicyContextEntry(entry) ? entry.pluginName : entry.appName;
}

function normalizePluginIdentityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readFirstString(record: JsonObject | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readNonBlankString(record?.[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}
