import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey, parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACTIVE_MEMORY_DEBUG_PREFIX,
  ACTIVE_MEMORY_STATUS_PREFIX,
  DEFAULT_AGENT_ID,
  type ActiveMemoryChatType,
  type ActiveMemorySearchDebug,
  type ActiveMemoryToggleEntry,
  type ActiveRecallResult,
  type PluginDebugEntry,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function resolveCanonicalSessionKeyFromSessionId(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  try {
    let bestMatch:
      | {
          sessionKey: string;
          updatedAt: number;
        }
      | undefined;
    for (const { sessionKey, entry } of params.api.runtime.agent.session.listSessionEntries({
      agentId: params.agentId,
    })) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidateSessionId =
        typeof (entry as { sessionId?: unknown }).sessionId === "string"
          ? (entry as { sessionId?: string }).sessionId?.trim()
          : "";
      if (!candidateSessionId || candidateSessionId !== sessionId) {
        continue;
      }
      const updatedAt =
        typeof (entry as { updatedAt?: unknown }).updatedAt === "number"
          ? ((entry as { updatedAt?: number }).updatedAt ?? 0)
          : 0;
      if (!bestMatch || updatedAt > bestMatch.updatedAt) {
        bestMatch = { sessionKey, updatedAt };
      }
    }
    return bestMatch?.sessionKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveRecallRunChannelContext(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): {
  messageChannel?: string;
  messageProvider?: string;
} {
  const isRunnableChannelName = (channel: string) =>
    !channel.includes(":") && !channel.includes("/");
  const explicitChannel = normalizeOptionalString(params.channelId);
  const explicitProvider = normalizeOptionalString(params.messageProvider);
  // A channelId that contains ":" is a scoped conversation id (e.g. Telegram
  // forum-topic "-100123:topic:77") or "/" (e.g. Google Chat "spaces/...") is
  // not a runnable channel name. Using it as the embedded recall run's channel
  // causes bundled-plugin dirName validation to throw (#76704, #78918).
  const runnableExplicitChannel =
    explicitChannel && isRunnableChannelName(explicitChannel) ? explicitChannel : undefined;
  // Non-webchat providers often pass a raw conversation id as channelId.
  // Keep those ids for filtering, but run the recall sub-agent through the provider.
  const trustedExplicitChannel =
    runnableExplicitChannel &&
    runnableExplicitChannel !== explicitProvider &&
    (!explicitProvider || explicitProvider === "webchat")
      ? runnableExplicitChannel
      : undefined;
  const resolveReturnValue = (paramsLocal: {
    resolvedChannel?: string;
    resolvedChannelStrength?: "strong" | "weak";
  }) => {
    const trustedResolvedChannel =
      paramsLocal.resolvedChannelStrength === "strong" ? paramsLocal.resolvedChannel : undefined;
    return {
      messageChannel:
        trustedExplicitChannel ??
        trustedResolvedChannel ??
        explicitProvider ??
        runnableExplicitChannel ??
        paramsLocal.resolvedChannel,
      messageProvider:
        trustedExplicitChannel ??
        trustedResolvedChannel ??
        explicitProvider ??
        runnableExplicitChannel ??
        paramsLocal.resolvedChannel,
    };
  };
  const resolvedSessionKey =
    normalizeOptionalString(params.sessionKey) ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  if (!resolvedSessionKey) {
    return resolveReturnValue({});
  }

  try {
    const sessionEntry = params.api.runtime.agent.session.getSessionEntry({
      agentId: params.agentId,
      sessionKey: resolvedSessionKey,
    });
    const rawStrongEntryChannel =
      normalizeOptionalString(sessionEntry?.lastChannel) ??
      normalizeOptionalString(sessionEntry?.channel);
    // Channel IDs containing ":" or "/" are scoped conversation IDs, not
    // runnable channel names. The same guard that
    // applies to explicit channelId (#76704) must also apply to channels
    // read from the session store (#77396).
    const strongEntryChannel =
      rawStrongEntryChannel && isRunnableChannelName(rawStrongEntryChannel)
        ? rawStrongEntryChannel
        : undefined;
    const weakEntryChannel = normalizeOptionalString(sessionEntry?.origin?.provider);
    return resolveReturnValue({
      resolvedChannel: strongEntryChannel ?? weakEntryChannel,
      resolvedChannelStrength: strongEntryChannel
        ? "strong"
        : weakEntryChannel
          ? "weak"
          : undefined,
    });
  } catch {
    return resolveReturnValue({});
  }
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function openActiveMemoryToggleStore(api: OpenClawPluginApi) {
  return api.runtime.state.openKeyedStore<ActiveMemoryToggleEntry>({
    namespace: "session-toggles",
    maxEntries: 10_000,
  });
}

async function isSessionActiveMemoryDisabled(params: {
  api: OpenClawPluginApi;
  sessionKey?: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  try {
    const store = openActiveMemoryToggleStore(params.api);
    const key = activeMemoryToggleKey(sessionKey);
    const stored = await store.lookup(key);
    if (stored?.disabled === true) {
      return true;
    }
    return false;
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: failed to read session toggle (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

async function setSessionActiveMemoryDisabled(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  disabled: boolean;
}): Promise<void> {
  const store = openActiveMemoryToggleStore(params.api);
  if (params.disabled) {
    await store.register(activeMemoryToggleKey(params.sessionKey), {
      sessionKey: params.sessionKey,
      disabled: true,
      updatedAt: Date.now(),
    });
  } else {
    await store.delete(activeMemoryToggleKey(params.sessionKey));
  }
}

function resolveCommandSessionKey(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  const explicit = params.sessionKey?.trim();
  if (explicit) {
    return explicit;
  }
  const configuredAgents =
    params.config.agents.length > 0 ? params.config.agents : [DEFAULT_AGENT_ID];
  for (const agentId of configuredAgents) {
    const sessionKey = resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId,
      sessionId: params.sessionId,
    });
    if (sessionKey) {
      return sessionKey;
    }
  }
  return undefined;
}

function formatActiveMemoryCommandHelp(): string {
  return [
    "Active Memory session toggle:",
    "/active-memory status",
    "/active-memory on",
    "/active-memory off",
    "",
    "Global config toggle:",
    "/active-memory status --global",
    "/active-memory on --global",
    "/active-memory off --global",
  ].join("\n");
}

function isActiveMemoryGloballyEnabled(cfg: OpenClawConfig): boolean {
  const entry = asRecord(cfg.plugins?.entries?.["active-memory"]);
  if (entry?.enabled === false) {
    return false;
  }
  const pluginConfig = resolvePluginConfigObject(cfg, "active-memory");
  return pluginConfig?.enabled !== false;
}

function updateActiveMemoryGlobalEnabledInConfig(
  cfg: OpenClawConfig,
  enabled: boolean,
): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = asRecord(entries["active-memory"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  entries["active-memory"] = {
    ...existingEntry,
    enabled: true,
    config: {
      ...existingConfig,
      enabled,
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function lacksAdminToMutateActiveMemoryGlobal(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  if (Array.isArray(params.gatewayClientScopes)) {
    return !params.gatewayClientScopes.includes("operator.admin");
  }
  return params.senderIsOwner !== true;
}

const ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT =
  "⚠️ /active-memory global enable/disable changes require owner or operator.admin.";

function isEnabledForAgent(
  config: ResolvedActiveRecallPluginConfig,
  agentId: string | undefined,
): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!agentId) {
    return false;
  }
  return config.agents.includes(agentId);
}

function isAgentHarnessSessionKey(sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  const rest = parseAgentSessionKey(normalized)?.rest ?? normalized;
  return rest.startsWith("harness:");
}

function shouldSkipActiveMemoryForHarnessSession(params: {
  api: OpenClawPluginApi;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  try {
    const entry = params.api.runtime.agent.session.getSessionEntry({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey,
      readConsistency: "latest",
    });
    // A missing reserved key must not synthesize work, while unlocked rows are
    // grandfathered user sessions from before the namespace was introduced.
    return (
      entry?.modelSelectionLocked === true ||
      (entry === undefined && isAgentHarnessSessionKey(sessionKey))
    );
  } catch {
    // Recall is optional. If durable ownership cannot be checked, do not risk
    // crossing a harness/model boundary with an independently selected model.
    return true;
  }
}

function isEligibleInteractiveSession(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): boolean {
  if (ctx.trigger !== "user") {
    return false;
  }
  // Exclude only canonical dreaming-narrative session keys (bare or agent-prefixed).
  // Canonical forms: "dreaming-narrative-<phase>-<hash>" or
  // "agent:<agentId>:dreaming-narrative-<phase>-<hash>".
  // A colon-delimited match would also exclude real chat session ids whose peer id
  // begins with a phased dreaming-narrative phrase (e.g.
  // "agent:main:feishu:group:dreaming-narrative-light-room").
  const sessionKey = ctx.sessionKey ?? "";
  if (
    /^dreaming-narrative-(light|rem|deep)-/i.test(sessionKey) ||
    /^agent:[^:]+:dreaming-narrative-(light|rem|deep)-/i.test(sessionKey)
  ) {
    return false;
  }
  if (!ctx.sessionKey && !ctx.sessionId) {
    return false;
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return true;
  }
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

function resolveChatType(ctx: {
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
  mainKey?: string;
}): ActiveMemoryChatType | undefined {
  const rawSessionKey = ctx.sessionKey?.trim();
  const { baseSessionKey } = parseThreadSessionSuffix(rawSessionKey);
  const sessionKey = (baseSessionKey ?? rawSessionKey)?.trim().toLowerCase();
  if (sessionKey) {
    if (sessionKey.startsWith("agent:") && sessionKey.split(":")[2] === "explicit") {
      return "explicit";
    }
    if (sessionKey.includes(":group:")) {
      return "group";
    }
    if (sessionKey.includes(":channel:")) {
      return "channel";
    }
    if (sessionKey.includes(":direct:") || sessionKey.includes(":dm:")) {
      return "direct";
    }
    const mainKey = ctx.mainKey?.trim().toLowerCase() || "main";
    const agentSessionParts = sessionKey.split(":");
    if (
      agentSessionParts.length === 3 &&
      agentSessionParts[0] === "agent" &&
      (agentSessionParts[2] === mainKey || agentSessionParts[2] === "main")
    ) {
      const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
      const channelId = (ctx.channelId ?? "").trim();
      if (provider && provider !== "webchat" && channelId) {
        return "direct";
      }
    }
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return "direct";
  }
  return undefined;
}

function isAllowedChatType(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
    mainKey?: string;
  },
): boolean {
  const chatType = resolveChatType(ctx);
  if (!chatType) {
    return false;
  }
  return config.allowedChatTypes.includes(chatType);
}

/**
 * Best-effort extraction of the conversation id (peer id) embedded in an
 * agent-scoped session key, using shared session-key utilities so we
 * stay aligned with the canonical key shapes produced by
 * `buildAgentPeerSessionKey` / `resolveThreadSessionKeys`.
 *
 * Supported shapes (after stripping the optional `:thread:<id>` suffix):
 *   - agent:<agentId>:direct:<peerId>                         (dmScope=per-peer)
 *   - agent:<agentId>:<channel>:direct:<peerId>               (dmScope=per-channel-peer)
 *   - agent:<agentId>:<channel>:<accountId>:direct:<peerId>   (dmScope=per-account-channel-peer)
 *   - agent:<agentId>:<channel>:group:<peerId>                (group)
 *   - agent:<agentId>:<channel>:channel:<peerId>              (channel)
 *
 * The legacy `dm` token is also accepted for backwards compatibility.
 *
 * Returns undefined for sessions that do not embed a peer id (for
 * example dmScope=main `agent:<agentId>:<mainKey>` sessions, or any
 * non-canonical session key shape).
 */
function resolveConversationId(ctx: {
  sessionKey?: string;
  messageProvider?: string;
}): string | undefined {
  const rawSessionKey = ctx.sessionKey?.trim();
  if (!rawSessionKey) {
    return undefined;
  }
  // Strip generic `:thread:<id>` suffix first so threaded sessions match
  // the same conversation id as their non-threaded parent. Provider-
  // specific topic ids (e.g. Telegram/Feishu) that are baked into the
  // peer id by the channel adapter are preserved.
  const { baseSessionKey } = parseThreadSessionSuffix(rawSessionKey);
  const baseKey = (baseSessionKey ?? rawSessionKey).trim();
  if (!baseKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(baseKey);
  if (!parsed) {
    return undefined;
  }
  const restParts = parsed.rest.split(":").filter(Boolean);
  if (restParts.length < 2) {
    // `agent:<agentId>:<mainKey>` (dmScope=main) lands here — there is
    // no embedded peer id to filter against.
    return undefined;
  }
  // Walk left-to-right until we hit the first chat-type marker. Every
  // canonical peer key terminates with `<chatType>:<peerId...>`, so the
  // tail after the first marker is the conversation id we want.
  for (let index = 0; index < restParts.length - 1; index += 1) {
    const token = restParts[index];
    if (token === "direct" || token === "dm" || token === "group" || token === "channel") {
      const tail = restParts
        .slice(index + 1)
        .join(":")
        .trim();
      return tail || undefined;
    }
  }
  return undefined;
}

/**
 * Apply allowedChatIds / deniedChatIds filters after the chat type check
 * has already passed. Empty allowedChatIds means "no allowlist" and this
 * function returns true for any conversation. Empty deniedChatIds is also
 * a no-op.
 *
 * When allowedChatIds is non-empty but the session key does not expose a
 * conversation id (e.g. webchat default session), the session is skipped
 * to avoid accidentally running against an unknown conversation.
 */
function isAllowedChatId(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
  },
): boolean {
  const hasAllowlist = config.allowedChatIds.length > 0;
  const hasDenylist = config.deniedChatIds.length > 0;
  if (!hasAllowlist && !hasDenylist) {
    return true;
  }
  const conversationId = resolveConversationId(ctx);
  if (hasAllowlist) {
    if (!conversationId) {
      return false;
    }
    if (!config.allowedChatIds.includes(conversationId)) {
      return false;
    }
  }
  if (hasDenylist && conversationId && config.deniedChatIds.includes(conversationId)) {
    return false;
  }
  return true;
}

function resolveStatusUpdateAgentId(ctx: { agentId?: string; sessionKey?: string }): string {
  const explicit = ctx.agentId?.trim();
  if (explicit) {
    return explicit;
  }
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return "";
  }
  const match = /^agent:([^:]+):/i.exec(sessionKey);
  return match?.[1]?.trim() ?? "";
}

function formatElapsedMsCompact(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0ms";
  }
  if (elapsedMs >= 1000) {
    const seconds = elapsedMs / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedMs)}ms`;
}

function buildPluginStatusLine(params: {
  result: ActiveRecallResult;
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const parts = [
    ACTIVE_MEMORY_STATUS_PREFIX,
    `status=${params.result.status}`,
    `elapsed=${formatElapsedMsCompact(params.result.elapsedMs)}`,
    `query=${params.config.queryMode}`,
  ];
  if (params.result.summary && params.result.summary.length > 0) {
    parts.push(`summary=${params.result.summary.length} chars`);
  }
  return parts.join(" ");
}

function buildPersistedDebugSummary(result: ActiveRecallResult): string | null {
  if (result.status === "timeout_partial") {
    return `timeout_partial: ${String(result.summary.length)} chars recovered (not persisted)`;
  }
  return result.summary;
}

function buildPluginDebugLine(params: {
  summary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): string | null {
  const cleaned = sanitizeDebugText(params.summary ?? "");
  const warning = sanitizeDebugText(params.searchDebug?.warning ?? "");
  const action = sanitizeDebugText(params.searchDebug?.action ?? "");
  const error = sanitizeDebugText(params.searchDebug?.error ?? "");
  const debugParts: string[] = [];
  const backend = sanitizeDebugText(params.searchDebug?.backend ?? "");
  if (backend) {
    debugParts.push(`backend=${backend}`);
  }
  const configuredMode = sanitizeDebugText(params.searchDebug?.configuredMode ?? "");
  if (configuredMode) {
    debugParts.push(`configuredMode=${configuredMode}`);
  }
  const effectiveMode = sanitizeDebugText(params.searchDebug?.effectiveMode ?? "");
  if (effectiveMode) {
    debugParts.push(`effectiveMode=${effectiveMode}`);
  }
  const fallback = sanitizeDebugText(params.searchDebug?.fallback ?? "");
  if (fallback) {
    debugParts.push(`fallback=${fallback}`);
  }
  if (
    typeof params.searchDebug?.searchMs === "number" &&
    Number.isFinite(params.searchDebug.searchMs)
  ) {
    debugParts.push(`searchMs=${Math.max(0, Math.round(params.searchDebug.searchMs))}`);
  }
  if (typeof params.searchDebug?.hits === "number" && Number.isFinite(params.searchDebug.hits)) {
    debugParts.push(`hits=${Math.max(0, Math.floor(params.searchDebug.hits))}`);
  }
  const prefix = debugParts.join(" ");
  const warningAction =
    warning && action && !cleaned
      ? `${warning} ${action}`
      : [warning, action && !cleaned ? action : ""]
          .filter((value): value is string => Boolean(value))
          .join(" | ");
  const messages = uniqueStrings(
    [warningAction, cleaned].filter((value): value is string => Boolean(value)),
  ).join(" | ");
  const trailing = messages;
  if (prefix && trailing) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${prefix} | ${trailing}`;
  }
  if (prefix) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${prefix}`;
  }
  if (messages) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${messages}`;
  }
  if (warning) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${warning}`;
  }
  if (cleaned) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${cleaned}`;
  }
  if (error) {
    return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${error}`;
  }
  return null;
}

function sanitizeDebugText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      sanitized += ch;
    }
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

async function persistPluginStatusLines(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  statusLine?: string;
  debugSummary?: string | null;
  searchDebug?: ActiveMemorySearchDebug;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const debugLine = buildPluginDebugLine({
    summary: params.debugSummary,
    searchDebug: params.searchDebug,
  });
  const agentId = params.agentId.trim();
  if (!agentId && (params.statusLine || debugLine)) {
    return;
  }
  try {
    if (!params.statusLine && !debugLine) {
      const existingEntry = params.api.runtime.agent.session.getSessionEntry({
        agentId,
        sessionKey,
      });
      const hasActiveMemoryEntry = Array.isArray(existingEntry?.pluginDebugEntries)
        ? existingEntry.pluginDebugEntries.some((entry) => entry?.pluginId === "active-memory")
        : false;
      if (!hasActiveMemoryEntry) {
        return;
      }
    }
    await params.api.runtime.agent.session.patchSessionEntry({
      agentId,
      sessionKey,
      preserveActivity: true,
      update: (existing) => {
        const previousEntries = Array.isArray(existing.pluginDebugEntries)
          ? existing.pluginDebugEntries
          : [];
        const nextEntries = previousEntries.filter(
          (entry): entry is PluginDebugEntry =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.pluginId === "string" &&
            entry.pluginId !== "active-memory",
        );
        const nextLines: string[] = [];
        if (params.statusLine) {
          nextLines.push(params.statusLine);
        }
        if (debugLine) {
          nextLines.push(debugLine);
        }
        if (nextLines.length > 0) {
          nextEntries.push({
            pluginId: "active-memory",
            lines: nextLines,
          });
        }
        return {
          pluginDebugEntries: nextEntries.length > 0 ? nextEntries : undefined,
        };
      },
    });
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: failed to persist session status note (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export {
  buildPersistedDebugSummary,
  buildPluginStatusLine,
  formatActiveMemoryCommandHelp,
  isActiveMemoryGloballyEnabled,
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isSessionActiveMemoryDisabled,
  lacksAdminToMutateActiveMemoryGlobal,
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
  resolveCommandSessionKey,
  resolveRecallRunChannelContext,
  resolveStatusUpdateAgentId,
  setSessionActiveMemoryDisabled,
  shouldSkipActiveMemoryForHarnessSession,
  updateActiveMemoryGlobalEnabledInConfig,
  ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
};
