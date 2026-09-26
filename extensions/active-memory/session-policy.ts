import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizePluginsConfig,
  resolvePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey, parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCanonicalSessionKeyFromSessionId } from "./session.js";
import {
  DEFAULT_AGENT_ID,
  type ActiveMemoryChatType,
  type ActiveMemoryToggleEntry,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

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
    return stored?.disabled === true;
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
  const entry = asOptionalRecord(cfg.plugins?.entries?.["active-memory"]);
  if (entry?.enabled === false) {
    return false;
  }
  const pluginConfig = resolvePluginConfigObject(cfg, "active-memory");
  return pluginConfig?.enabled !== false;
}

function isActiveMemoryPluginEnabled(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled || plugins.deny.includes("active-memory")) {
    return false;
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes("active-memory")) {
    return false;
  }
  return plugins.entries["active-memory"]?.enabled !== false;
}

function updateActiveMemoryGlobalEnabledInConfig(
  cfg: OpenClawConfig,
  enabled: boolean,
): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = asOptionalRecord(entries["active-memory"]) ?? {};
  const existingConfig = asOptionalRecord(existingEntry.config) ?? {};
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
  return Boolean(config.enabled && agentId && config.agents.includes(agentId));
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
  inputProvenance?: { kind?: string };
}): boolean {
  if (ctx.trigger !== "user") {
    return false;
  }
  // Inter-session deliveries retain the user trigger. Their typed origin keeps
  // them out of human-message recall.
  if (ctx.inputProvenance?.kind === "inter_session") {
    return false;
  }
  // Match only bare or agent-prefixed narrative keys, not chat peer ids such as
  // "agent:main:feishu:group:dreaming-narrative-light-room".
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

function isPrivateRecallDestination(ctx: {
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
  mainKey?: string;
}): boolean {
  const chatType = resolveChatType(ctx);
  return chatType === "direct" || chatType === "explicit";
}

// Canonical peer keys end with <chatType>:<peerId...>, after optional channel
// and account prefixes. Main sessions have no embedded peer; legacy dm is accepted.
function resolveConversationId(ctx: {
  sessionKey?: string;
  messageProvider?: string;
}): string | undefined {
  const rawSessionKey = ctx.sessionKey?.trim();
  if (!rawSessionKey) {
    return undefined;
  }
  // Strip generic threads while retaining provider-specific topics inside the peer id.
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

function isAllowedChatId(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
  },
): boolean {
  const hasAllowlist = config.allowedChatIds.length > 0;
  const hasDenylist = config.deniedChatIds.length > 0;
  if (!hasAllowlist && !hasDenylist) {
    return true;
  }
  // dmScope=main direct sessions omit the peer id from the key. Fall back to
  // the trusted hook chat id so allow/deny lists still apply.
  const conversationId =
    (resolveConversationId(ctx) ?? ctx.channelId?.trim())?.toLowerCase() || undefined;
  if (hasAllowlist && (!conversationId || !config.allowedChatIds.includes(conversationId))) {
    return false;
  }
  if (hasDenylist && conversationId && config.deniedChatIds.includes(conversationId)) {
    return false;
  }
  return true;
}

export {
  ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
  formatActiveMemoryCommandHelp,
  isActiveMemoryGloballyEnabled,
  isActiveMemoryPluginEnabled,
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isPrivateRecallDestination,
  isSessionActiveMemoryDisabled,
  lacksAdminToMutateActiveMemoryGlobal,
  resolveCommandSessionKey,
  setSessionActiveMemoryDisabled,
  shouldSkipActiveMemoryForHarnessSession,
  updateActiveMemoryGlobalEnabledInConfig,
};
