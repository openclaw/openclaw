import {
  embeddedAgentLog,
  type CodexBundleMcpThreadConfig,
  type ExecApprovalDecision,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  formatMcpCodexApprovalRemedy,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import { codexAppIdentityKey } from "./app-identity.js";
import {
  createCodexElicitationResponse,
  type CodexElicitationResponse,
} from "./elicitation-response.js";
import type { CodexActiveMcpToolCall } from "./event-projector-native-tool-lifecycle.js";
import {
  requestPluginApproval,
  requestPluginApprovalOutcome,
  sanitizeCodexApprovalVisibleText,
  truncateCodexApprovalDisplayText as truncateDisplayText,
  type PluginApprovalOutcome,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import type {
  CodexAppPolicyContextEntry,
  PluginAppPolicyContext,
  PluginAppPolicyContextEntry,
} from "./session-binding-record-codec.js";

type ApprovalPropertyContext = {
  name: string;
  schema: JsonObject;
};

type BridgeableApprovalElicitation = {
  title: string;
  description: string;
  requestedSchema: JsonObject;
  meta: JsonObject;
  persistHintsMode?: "legacy" | "explicit";
  allowedDecisions?: ExecApprovalDecision[];
};

type CodexApprovalElicitationResult =
  | { kind: "not-mine" }
  | { kind: "handled"; response: CodexElicitationResponse };

type PluginElicitationResolution =
  | { kind: "not_plugin" }
  | { kind: "matched"; entry: CodexAppPolicyContextEntry }
  | { kind: "decline"; reason: string };

const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";
const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY = "connector_name";
const MCP_TOOL_APPROVAL_TOOL_TITLE_KEY = "tool_title";
const MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY = "tool_description";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = "tool_params_display";
const MCP_TOOL_APPROVAL_SOURCE_KEY = "source";
const MCP_TOOL_APPROVAL_CONNECTOR_SOURCE = "connector";
const CODEX_APPS_SERVER_NAME = "codex_apps";
const COMPUTER_USE_APPROVAL_TITLE = "Computer Use approval";
const EMPTY_OBJECT_SCHEMA: JsonObject = { type: "object", properties: {} };
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
const MAX_DISPLAY_PARAM_ENTRIES = 8;
const MAX_DISPLAY_PARAM_VALUE_LENGTH = 120;
const MAX_DISPLAY_VALUE_ARRAY_ITEMS = 8;
const MAX_DISPLAY_VALUE_OBJECT_KEYS = 8;
const MAX_DISPLAY_VALUE_DEPTH = 3;
const DISPLAY_TEXT_SCAN_MAX_LENGTH = 4096;

export async function routeCodexAppServerElicitationRequest(params: {
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  computerUseMcpServerName?: string;
  autoApproveMcpTools?: boolean;
  projectedMcpServers?: NonNullable<CodexBundleMcpThreadConfig["configPatch"]>["mcp_servers"];
  getActiveMcpToolCall?: (serverName: string) => CodexActiveMcpToolCall | undefined;
  signal?: AbortSignal;
}): Promise<CodexApprovalElicitationResult> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!requestParams || readNonBlankString(requestParams.threadId) !== params.threadId) {
    return { kind: "not-mine" };
  }
  const requestTurnId = requestParams.turnId;
  if (requestTurnId !== null && requestTurnId !== undefined && requestTurnId !== params.turnId) {
    return { kind: "not-mine" };
  }
  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : undefined;
  const approvalShaped =
    meta?.[MCP_TOOL_APPROVAL_KIND_KEY] === MCP_TOOL_APPROVAL_KIND ||
    (params.computerUseMcpServerName !== undefined &&
      readNonBlankString(requestParams.serverName) === params.computerUseMcpServerName);
  // Plugin ownership identifies which approval policy applies; it does not turn
  // ordinary MCP forms or OAuth URLs into destructive-action approvals.
  if (!approvalShaped) {
    return { kind: "not-mine" };
  }
  if (params.signal?.aborted) {
    return handled(createCodexElicitationResponse("cancel"));
  }
  const pluginResolution = resolvePluginElicitation({
    requestParams,
    pluginAppPolicyContext: params.pluginAppPolicyContext,
  });
  if (pluginResolution.kind !== "not_plugin") {
    if (params.paramsForRun.trigger === "cron" && params.paramsForRun.scheduledRuntimeAuthority) {
      logPluginElicitationDecline("scheduled_authority_non_interactive", requestParams);
      return handled(createCodexElicitationResponse("decline"));
    }
    if (pluginResolution.kind === "decline") {
      logPluginElicitationDecline(pluginResolution.reason, requestParams);
      return handled(createCodexElicitationResponse("decline"));
    }
    if (requestTurnId !== params.turnId) {
      logPluginElicitationDecline("missing_active_turn", requestParams);
      return handled(createCodexElicitationResponse("decline"));
    }
    return handled(
      await buildPluginPolicyElicitationResponse({
        entry: pluginResolution.entry,
        requestParams,
        paramsForRun: params.paramsForRun,
        signal: params.signal,
      }),
    );
  }

  const serverName = readNonBlankString(requestParams.serverName);
  const computerUsePrompt =
    serverName && serverName === params.computerUseMcpServerName
      ? readApprovalElicitation(requestParams, { kind: "computer-use" })
      : undefined;
  const approvalPrompt =
    computerUsePrompt ?? readApprovalElicitation(requestParams, { kind: "mcp" });
  if (!approvalPrompt) {
    return handled(createCodexElicitationResponse("decline"));
  }
  let persistence:
    | Pick<
        Parameters<typeof requestPluginApproval>[0],
        "mcpTool" | "toolCallId" | "isMcpToolApprovalActive"
      >
    | undefined;
  if (!computerUsePrompt) {
    // App elicitation delegation changes Codex's policy; custom MCP servers still
    // follow the original operator posture unless their server config overrides it.
    const server = serverName ? params.paramsForRun.config?.mcp?.servers?.[serverName] : undefined;
    const mode = serverName
      ? resolveProjectedMcpCodexToolApprovalMode(
          serverName,
          server ?? {},
          params.projectedMcpServers?.[serverName],
        )
      : undefined;
    if (!requiresMcpCodexToolApproval({ mode, fullPermission: params.autoApproveMcpTools })) {
      params.paramsForRun.hostCapabilities.assertActive();
      return handled(buildElicitationResponse(approvalPrompt, "approved-once"));
    }
    // Explicit prompt is per-call consent, even if stale persistence hints arrive.
    if (mode === "prompt") {
      approvalPrompt.allowedDecisions = ["allow-once", "deny"];
    } else if (
      serverName &&
      serverName !== CODEX_APPS_SERVER_NAME &&
      Object.hasOwn(params.paramsForRun.config?.mcp?.servers ?? {}, serverName) &&
      requestTurnId === params.turnId &&
      readPersistHints(approvalPrompt.meta, "explicit").includes("always")
    ) {
      const resolveItem = () => {
        const item = params.getActiveMcpToolCall?.(serverName);
        return item?.server === serverName && matchesMcpApprovalDisplay(item, approvalPrompt.meta)
          ? item
          : undefined;
      };
      const item = resolveItem();
      if (item) {
        persistence = {
          mcpTool: { server: serverName, tool: item.tool },
          toolCallId: item.id,
          // Recheck at the gateway's mint boundary: another call may start or
          // this item may finish while the operator's approval card is pending.
          isMcpToolApprovalActive: () => {
            const current = resolveItem();
            return current?.id === item.id && current.tool === item.tool;
          },
        };
      }
    }
  }

  const outcome = await requestPluginApprovalOutcome({
    hostCapabilities: params.paramsForRun.hostCapabilities,
    title: approvalPrompt.title,
    description: approvalPrompt.description,
    allowedDecisions: approvalPrompt.allowedDecisions,
    toolName: "codex_mcp_tool_approval",
    ...persistence,
    signal: params.signal,
  });
  return handled(buildElicitationResponse(approvalPrompt, outcome));
}

function matchesMcpApprovalDisplay(item: CodexActiveMcpToolCall, meta: JsonObject): boolean {
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

function handled(response: CodexElicitationResponse): CodexApprovalElicitationResult {
  return { kind: "handled", response };
}

function resolvePluginElicitation(params: {
  requestParams: JsonObject;
  pluginAppPolicyContext?: PluginAppPolicyContext;
}): PluginElicitationResolution {
  const requestParams = params.requestParams;
  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
  const context = params.pluginAppPolicyContext;
  const entries = context ? Object.values(context.apps) : [];
  const pluginEntries = entries.filter(isPluginAppPolicyContextEntry);
  const readIdentity = (keys: string[]) =>
    readFirstString(meta, keys) ?? readFirstString(requestParams, keys);

  const appId = readIdentity(PLUGIN_APP_ID_META_KEYS);
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
    const matches = Object.entries(context.apps)
      .filter(([id]) => codexAppIdentityKey(id) === codexAppIdentityKey(matchedAppId))
      .map(([, entry]) => entry);
    if (matches.some((entry) => entry.source === "account") && !isCodexConnectorApproval) {
      return { kind: "decline", reason: "account_app_source_mismatch" };
    }
    return uniquePluginMatch(matches, appId ? "app_id" : "connector_id");
  }

  const serverName = readNonBlankString(requestParams.serverName);
  if (serverName && context) {
    const matches = entries.filter((entry) => entry.mcpServerNames.includes(serverName));
    if (matches.length > 0) {
      return uniquePluginMatch(matches, "server_name");
    }
  }

  const pluginName = readIdentity(PLUGIN_NAME_META_KEYS);
  const configKey = readIdentity(PLUGIN_CONFIG_KEY_META_KEYS);
  const marketplaceName = readIdentity(PLUGIN_MARKETPLACE_NAME_META_KEYS);
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

function isCodexConnectorApprovalElicitation(requestParams: JsonObject, meta: JsonObject): boolean {
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

function isPluginAppPolicyContextEntry(
  entry: CodexAppPolicyContextEntry,
): entry is PluginAppPolicyContextEntry {
  return entry.source !== "account";
}

function appPolicyDisplayName(entry: CodexAppPolicyContextEntry): string {
  return isPluginAppPolicyContextEntry(entry) ? entry.pluginName : entry.appName;
}

function normalizePluginIdentityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function buildPluginPolicyElicitationResponse(params: {
  entry: CodexAppPolicyContextEntry;
  requestParams: JsonObject;
  paramsForRun: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
}): Promise<CodexElicitationResponse> {
  const mode =
    params.entry.destructiveApprovalMode ??
    (params.entry.allowDestructiveActions ? "allow" : "deny");
  const meta = isJsonObject(params.requestParams._meta) ? params.requestParams._meta : {};
  // Hosted apps have their destructive ceiling enforced in the thread's tool
  // config before dispatch. A remaining native prompt can require consent for
  // an allowed read; plugin-provided MCP servers still use the decline policy.
  if (mode === "deny" && !isCodexConnectorApprovalElicitation(params.requestParams, meta)) {
    logPluginElicitationDecline("destructive_actions_disabled", params.requestParams);
    return createCodexElicitationResponse("decline");
  }
  const approvalPrompt = readApprovalElicitation(params.requestParams, {
    kind: "plugin",
    displayName: appPolicyDisplayName(params.entry),
  });
  if (!approvalPrompt) {
    logPluginElicitationDecline("unsupported_schema", params.requestParams);
    return createCodexElicitationResponse("decline");
  }
  const response = buildElicitationResponse(approvalPrompt, "approved-once");
  if (response.action !== "accept") {
    logPluginElicitationDecline("unmappable_schema", params.requestParams);
    return createCodexElicitationResponse("decline");
  }
  if (mode === "allow") {
    return response;
  }
  const allowedDecisions: ExecApprovalDecision[] = approvalPrompt.allowedDecisions ?? [
    "allow-once",
    "deny",
  ];
  const outcome = await requestPluginApprovalOutcome({
    hostCapabilities: params.paramsForRun.hostCapabilities,
    title: approvalPrompt.title,
    description: approvalPrompt.description,
    allowedDecisions:
      mode === "ask"
        ? allowedDecisions.filter((decision) => decision !== "allow-always")
        : allowedDecisions,
    toolName: "codex_mcp_tool_approval",
    signal: params.signal,
  });
  return buildElicitationResponse(approvalPrompt, outcome);
}

function readApprovalElicitation(
  requestParams: JsonObject,
  source: { kind: "plugin"; displayName: string } | { kind: "mcp" | "computer-use" },
): BridgeableApprovalElicitation | undefined {
  if (
    readNonBlankString(requestParams.mode) !== "form" ||
    (source.kind === "mcp" &&
      (!isJsonObject(requestParams._meta) ||
        requestParams._meta[MCP_TOOL_APPROVAL_KIND_KEY] !== MCP_TOOL_APPROVAL_KIND))
  ) {
    return undefined;
  }
  const requestedSchema = isJsonObject(requestParams.requestedSchema)
    ? requestParams.requestedSchema
    : source.kind === "computer-use"
      ? EMPTY_OBJECT_SCHEMA
      : undefined;
  if (
    !requestedSchema ||
    readNonBlankString(requestedSchema.type) !== "object" ||
    !isJsonObject(requestedSchema.properties)
  ) {
    return undefined;
  }

  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
  const title =
    sanitizeDisplayText(readNonBlankString(requestParams.message) ?? "") ||
    (source.kind === "plugin"
      ? "Codex plugin approval"
      : source.kind === "mcp"
        ? "Codex MCP tool approval"
        : COMPUTER_USE_APPROVAL_TITLE);
  const serverName = readNonBlankString(requestParams.serverName);
  const descriptionMeta: JsonObject = source.kind === "plugin" ? { ...meta } : meta;
  if (
    source.kind === "plugin" &&
    !readNonBlankString(descriptionMeta[MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY])
  ) {
    descriptionMeta[MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY] = source.displayName;
  }
  return {
    title,
    description: buildApprovalDescription({
      title,
      meta: descriptionMeta,
      requestedSchema,
      serverName: sanitizeOptionalDisplayText(serverName),
      // Plugin and computer-use prompts have their own policies, not an MCP config remedy.
      remedy:
        source.kind === "mcp" && serverName ? formatMcpCodexApprovalRemedy(serverName) : undefined,
    }),
    requestedSchema,
    meta,
    ...(source.kind !== "computer-use"
      ? {
          persistHintsMode: "explicit" as const,
          allowedDecisions: canMapPersistentApproval(requestedSchema, meta, source.kind === "mcp")
            ? ["allow-once", "allow-always", "deny"]
            : ["allow-once", "deny"],
        }
      : {}),
  };
}

function canMapPersistentApproval(
  requestedSchema: JsonObject,
  meta: JsonObject,
  allowSession: boolean,
): boolean {
  const persistHints = readPersistHints(meta, "explicit");
  if (allowSession) {
    return choosePersistHint(persistHints) !== undefined;
  }
  if (persistHints.length > 0) {
    return persistHints.includes("always");
  }
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return readApprovalProperties(properties).some(
    (property) =>
      isPersistField(property) &&
      chooseAlwaysPersistOptionValue(readEnumOptions(property.schema)) !== undefined,
  );
}

function logPluginElicitationDecline(reason: string, requestParams: JsonObject | undefined): void {
  embeddedAgentLog.debug("codex plugin elicitation declined", {
    reason,
    serverName: readNonBlankString(requestParams?.serverName),
    mode: readNonBlankString(requestParams?.mode),
  });
}

function buildApprovalDescription(params: {
  title: string;
  meta: JsonObject;
  requestedSchema: JsonObject;
  serverName: string | undefined;
  remedy?: string;
}): string {
  const connectorName = sanitizeOptionalDisplayText(
    readNonBlankString(params.meta[MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY]),
  );
  const toolTitle = sanitizeOptionalDisplayText(
    readNonBlankString(params.meta[MCP_TOOL_APPROVAL_TOOL_TITLE_KEY]),
  );
  const toolDescription = sanitizeOptionalDisplayText(
    readNonBlankString(params.meta[MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY]),
  );
  const summaryLines = [
    connectorName && `App: ${connectorName}`,
    toolTitle && `Tool: ${toolTitle}`,
    params.serverName && `MCP server: ${params.serverName}`,
    // Before the tool description: card text is truncated at 256 chars and the
    // remedy is the line the operator must not lose.
    params.remedy,
    toolDescription,
  ].filter((line): line is string => Boolean(line));
  const paramLines = readDisplayParamLines(params.meta);
  const propertyLines = readPropertyDescriptionLines(params.requestedSchema);
  return [
    params.title,
    summaryLines.join("\n"),
    paramLines.length > 0 ? ["Parameters:", ...paramLines].join("\n") : "",
    propertyLines.length > 0 ? ["Fields:", ...propertyLines].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readPropertyDescriptionLines(requestedSchema: JsonObject): string[] {
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return readApprovalProperties(properties).map(({ name, schema }) => {
    const propTitle =
      sanitizeDisplayText(readNonBlankString(schema.title) ?? "") ||
      sanitizeDisplayText(name) ||
      "field";
    const description = sanitizeOptionalDisplayText(readNonBlankString(schema.description));
    return description ? `- ${propTitle}: ${description}` : `- ${propTitle}`;
  });
}

function readApprovalProperties(properties: JsonObject): ApprovalPropertyContext[] {
  return Object.entries(properties).flatMap(([name, schema]) =>
    isJsonObject(schema) ? [{ name, schema }] : [],
  );
}

function readDisplayParamLines(meta: JsonObject): string[] {
  const displayParams = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY];
  if (!Array.isArray(displayParams)) {
    return [];
  }
  const lines = displayParams
    .slice(0, MAX_DISPLAY_PARAM_ENTRIES)
    .map((entry) => {
      const param = isJsonObject(entry) ? entry : undefined;
      if (!param) {
        return undefined;
      }
      const name =
        sanitizeOptionalDisplayText(readNonBlankString(param.display_name)) ??
        sanitizeOptionalDisplayText(readNonBlankString(param.name));
      if (!name) {
        return undefined;
      }
      return `- ${name}: ${formatDisplayParamValue(param.value)}`;
    })
    .filter((line): line is string => Boolean(line));
  const remaining = displayParams.length - MAX_DISPLAY_PARAM_ENTRIES;
  return remaining > 0 ? [...lines, `- Additional parameters: ${remaining} more`] : lines;
}

function formatDisplayParamValue(value: JsonValue | undefined): string {
  const formatted = typeof value === "string" ? value : formatDisplayJsonValue(value ?? null);
  return truncateDisplayText(sanitizeDisplayText(formatted), MAX_DISPLAY_PARAM_VALUE_LENGTH);
}

function formatDisplayJsonValue(value: JsonValue, depth = MAX_DISPLAY_VALUE_DEPTH): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(truncateDisplayText(sanitizeDisplayText(value), 80));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (depth <= 0) {
      return "[truncated]";
    }
    const parts: string[] = [];
    const limit = Math.min(value.length, MAX_DISPLAY_VALUE_ARRAY_ITEMS);
    for (let i = 0; i < limit; i += 1) {
      parts.push(formatDisplayJsonValue(value[i] ?? null, depth - 1));
    }
    if (value.length > MAX_DISPLAY_VALUE_ARRAY_ITEMS) {
      parts.push("...");
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    if (depth <= 0) {
      return "{truncated}";
    }
    const parts: string[] = [];
    let count = 0;
    let truncated = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (count >= MAX_DISPLAY_VALUE_OBJECT_KEYS) {
        truncated = true;
        break;
      }
      const safeKey = truncateDisplayText(sanitizeDisplayText(key), 80);
      parts.push(
        `${JSON.stringify(safeKey)}:${formatDisplayJsonValue(value[key] ?? null, depth - 1)}`,
      );
      count += 1;
    }
    if (truncated) {
      parts.push("...");
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

function sanitizeOptionalDisplayText(value: string | undefined): string | undefined {
  const sanitized = value === undefined ? "" : sanitizeDisplayText(value);
  return sanitized || undefined;
}

function sanitizeDisplayText(value: string): string {
  const scanned = sliceUtf16Safe(value, 0, DISPLAY_TEXT_SCAN_MAX_LENGTH);
  const clipped = value.length > DISPLAY_TEXT_SCAN_MAX_LENGTH;
  const sanitized = sanitizeCodexApprovalVisibleText(scanned, {
    stripDanglingTerminalSequence: true,
  });
  const escaped = sanitized ? formatCodexDisplayText(sanitized) : "";
  return clipped && escaped ? `${escaped}...` : escaped;
}

function buildElicitationResponse(
  approvalPrompt: Pick<
    BridgeableApprovalElicitation,
    "requestedSchema" | "meta" | "persistHintsMode"
  >,
  outcome: PluginApprovalOutcome,
): CodexElicitationResponse {
  const { requestedSchema, meta } = approvalPrompt;
  if (outcome === "cancelled") {
    return createCodexElicitationResponse("cancel");
  }
  // Codex reads no response meta on decline (0.151.0 maps every decline to
  // "user rejected MCP tool call"), so remedy text belongs on the operator card.
  if (outcome === "timed-out" || outcome === "denied" || outcome === "unavailable") {
    return createCodexElicitationResponse("decline");
  }

  const content = buildAcceptedContent(approvalPrompt, outcome);
  if (!content && !hasNoSchemaProperties(requestedSchema)) {
    embeddedAgentLog.warn("codex MCP approval elicitation approved without a mappable response", {
      approvalKind: meta[MCP_TOOL_APPROVAL_KIND_KEY],
      fields: Object.keys(requestedSchema.properties ?? {}),
      outcome,
    });
    return createCodexElicitationResponse("decline");
  }
  return createCodexElicitationResponse(
    "accept",
    content ?? null,
    buildAcceptedMeta(meta, outcome, approvalPrompt.persistHintsMode ?? "legacy"),
  );
}

function buildAcceptedContent(
  approvalPrompt: Pick<
    BridgeableApprovalElicitation,
    "requestedSchema" | "meta" | "persistHintsMode"
  >,
  outcome: "approved-once" | "approved-session",
): JsonObject | undefined {
  const { requestedSchema, meta } = approvalPrompt;
  const properties = isJsonObject(requestedSchema.properties)
    ? requestedSchema.properties
    : undefined;
  if (!properties) {
    return undefined;
  }
  const required = Array.isArray(requestedSchema.required)
    ? new Set(
        requestedSchema.required.filter((entry): entry is string => typeof entry === "string"),
      )
    : new Set<string>();
  const content: JsonObject = {};
  let sawApprovalField = false;
  const persist = choosePersistHint(readPersistHints(meta, approvalPrompt.persistHintsMode));

  for (const property of readApprovalProperties(properties)) {
    const next = readAcceptedPropertyValue(
      property,
      outcome,
      persist,
      approvalPrompt.persistHintsMode ?? "legacy",
    );

    if (isApprovalField(property)) {
      sawApprovalField = true;
    }
    if (next === undefined) {
      if (required.has(property.name)) {
        return undefined;
      }
      continue;
    }

    content[property.name] = next;
  }

  return sawApprovalField ? content : undefined;
}

function readAcceptedPropertyValue(
  property: ApprovalPropertyContext,
  outcome: "approved-once" | "approved-session",
  persist: "always" | "session" | undefined,
  persistHintsMode: "legacy" | "explicit",
): JsonValue | undefined {
  if (isApprovalField(property)) {
    if (readNonBlankString(property.schema.type) === "boolean") {
      return true;
    }
    const options = readEnumOptions(property.schema);
    const choice =
      (outcome === "approved-session"
        ? options.find((option) => isPersistentApprovalOption(option, persist))
        : undefined) ?? options.find(isPositiveApprovalOption);
    if (choice) {
      return choice.value;
    }
  }
  if (!isPersistField(property)) {
    return property.schema.default;
  }
  if (outcome === "approved-once") {
    return undefined;
  }
  const options = readEnumOptions(property.schema);
  const choice = persist
    ? options.find((option) => option.value === persist || option.label === persist)?.value
    : persistHintsMode === "explicit"
      ? chooseAlwaysPersistOptionValue(options)
      : undefined;
  return choice ?? property.schema.default;
}

function isApprovalField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(approve|approval|allow|accept|decision)\b/.test(haystack);
}

function isPersistField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(persist|session|always|scope)\b/.test(haystack);
}

function propertyText(property: ApprovalPropertyContext): string {
  return [
    property.name,
    readNonBlankString(property.schema.title),
    readNonBlankString(property.schema.description),
  ]
    .filter(Boolean)
    .join(" ");
}

function readPersistHints(meta: JsonObject, mode: "legacy" | "explicit" = "legacy"): string[] {
  const raw = meta.persist;
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  return mode === "legacy" ? ["session", "always"] : [];
}

function buildAcceptedMeta(
  meta: JsonObject,
  outcome: "approved-once" | "approved-session",
  persistHintsMode: "legacy" | "explicit",
): JsonObject | null {
  if (outcome !== "approved-session") {
    return null;
  }
  const persist = choosePersistHint(readPersistHints(meta, persistHintsMode));
  return persist ? { persist } : null;
}

function choosePersistHint(persistHints: string[]): "always" | "session" | undefined {
  return (["always", "session"] as const).find((hint) => persistHints.includes(hint));
}

function chooseAlwaysPersistOptionValue(
  options: Array<{ value: string; label: string }>,
): string | undefined {
  return options.find(
    (option) => option.value.toLowerCase() === "always" || option.label.toLowerCase() === "always",
  )?.value;
}

function hasNoSchemaProperties(requestedSchema: JsonObject): boolean {
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return Object.keys(properties).length === 0;
}

function readEnumOptions(schema: JsonObject): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((entry): entry is string => typeof entry === "string");
    const labels = Array.isArray(schema.enumNames)
      ? schema.enumNames.filter((entry): entry is string => typeof entry === "string")
      : [];
    return values.map((value, index) => ({ value, label: labels[index] ?? value }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((entry) => {
      const option = isJsonObject(entry) ? entry : undefined;
      const value = readNonBlankString(option?.const);
      return value ? [{ value, label: readNonBlankString(option?.title) ?? value }] : [];
    });
  }
  return [];
}

function isPositiveApprovalOption(option: { value: string; label: string }): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  return /\b(allow|approve|accept|yes|continue|proceed|true)\b/.test(haystack);
}

function isPersistentApprovalOption(
  option: { value: string; label: string },
  persist: "always" | "session" | undefined,
): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  const scopeMatches =
    persist === "always"
      ? /\b(always|persistent)\b|\bdon't ask me again\b/.test(haystack)
      : persist === "session" && /\bsession\b/.test(haystack);
  return scopeMatches && /\b(allow|approve|accept)\b/.test(haystack);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
