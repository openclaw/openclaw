import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type {
  DiscordAccountConfig,
  DiscordGuildChannelConfig,
  TelegramAccountConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { logVerbose } from "../globals.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { pickFirstExistingAgentId } from "../routing/resolve-route.js";
import { normalizeAccountId, sanitizeAgentId } from "../routing/session-key.js";
import { getAcpSessionManager } from "./control-plane/manager.js";
import { readAcpSessionEntry } from "./runtime/session-meta.js";
import type { AcpRuntimeSessionMode } from "./runtime/types.js";

type ConfiguredAcpBindingChannel = "discord" | "telegram";

export type ConfiguredAcpBindingSpec = {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  agentId: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
};

type ResolvedConfiguredAcpBinding = {
  spec: ConfiguredAcpBindingSpec;
  record: SessionBindingRecord;
};

type AcpBindingConfigShape = {
  enabled?: boolean;
  agentId?: string;
  mode?: string;
  cwd?: string;
  backend?: string;
  label?: string;
};

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeMode(value: unknown): AcpRuntimeSessionMode {
  const raw = normalizeText(value)?.toLowerCase();
  return raw === "oneshot" ? "oneshot" : "persistent";
}

function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const shape = raw as AcpBindingConfigShape;
  if (shape.enabled === false) {
    return null;
  }
  const agentId = normalizeText(shape.agentId);
  if (!agentId) {
    return null;
  }
  return {
    enabled: shape.enabled,
    agentId,
    mode: normalizeMode(shape.mode),
    cwd: normalizeText(shape.cwd),
    backend: normalizeText(shape.backend),
    label: normalizeText(shape.label),
  };
}

function buildBindingHash(params: {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

export function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string {
  const hash = buildBindingHash({
    channel: spec.channel,
    accountId: spec.accountId,
    conversationId: spec.conversationId,
  });
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}

function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord {
  return {
    bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
    targetSessionKey: buildConfiguredAcpSessionKey(spec),
    targetKind: "session",
    conversation: {
      channel: spec.channel,
      accountId: spec.accountId,
      conversationId: spec.conversationId,
      parentConversationId: spec.parentConversationId,
    },
    status: "active",
    boundAt: 0,
    metadata: {
      source: "config",
      mode: "persistent",
      agentId: spec.agentId,
      label: spec.label,
      ...(spec.backend ? { backend: spec.backend } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
  };
}

function resolveDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig {
  const discord = cfg.channels?.discord;
  if (!discord) {
    return {};
  }
  const { accounts: _ignored, ...base } = discord as DiscordAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountEntry(discord.accounts, accountId) ?? {};
  return { ...base, ...account };
}

function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const telegram = cfg.channels?.telegram;
  if (!telegram) {
    return {};
  }
  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = telegram as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountEntry(telegram.accounts, accountId) ?? {};
  const configuredAccountIds = Object.keys(telegram.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);
  return { ...base, ...account, groups };
}

function findDiscordChannelBinding(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationCandidates: string[];
}): {
  channelId: string;
  binding: AcpBindingConfigShape;
  channelConfig: DiscordGuildChannelConfig;
} | null {
  const discordConfig = resolveDiscordAccountConfig(params.cfg, params.accountId);
  const guilds = discordConfig.guilds;
  if (!guilds || typeof guilds !== "object") {
    return null;
  }
  for (const guild of Object.values(guilds)) {
    const channels = guild?.channels;
    if (!channels || typeof channels !== "object") {
      continue;
    }
    for (const candidate of params.conversationCandidates) {
      const channelConfig = channels[candidate];
      if (!channelConfig || typeof channelConfig !== "object") {
        continue;
      }
      const rawBinding = channelConfig.bindings?.acp;
      const binding = normalizeBindingConfig(rawBinding);
      if (!binding) {
        continue;
      }
      return {
        channelId: candidate,
        binding,
        channelConfig,
      };
    }
  }
  return null;
}

function parseTelegramTopicConversation(params: {
  conversationId: string;
  parentConversationId?: string;
}): { chatId: string; topicId: string; canonicalConversationId: string } | null {
  const conversation = params.conversationId.trim();
  const directMatch = conversation.match(/^(-?\d+):topic:(\d+)$/);
  if (directMatch?.[1] && directMatch[2]) {
    return {
      chatId: directMatch[1],
      topicId: directMatch[2],
      canonicalConversationId: `${directMatch[1]}:topic:${directMatch[2]}`,
    };
  }
  if (!/^\d+$/.test(conversation)) {
    return null;
  }
  const parent = params.parentConversationId?.trim();
  if (!parent || !/^-?\d+$/.test(parent)) {
    return null;
  }
  return {
    chatId: parent,
    topicId: conversation,
    canonicalConversationId: `${parent}:topic:${conversation}`,
  };
}

function findTelegramTopicBinding(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): {
  topicConfig: TelegramTopicConfig;
  binding: AcpBindingConfigShape;
  chatId: string;
  topicId: string;
  canonicalConversationId: string;
} | null {
  const parsed = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.chatId.startsWith("-")) {
    return null;
  }
  const telegramConfig = resolveTelegramAccountConfig(params.cfg, params.accountId);
  const groupConfig = telegramConfig.groups?.[parsed.chatId];
  const topicConfig = groupConfig?.topics?.[parsed.topicId];
  if (!topicConfig || typeof topicConfig !== "object") {
    return null;
  }
  const binding = normalizeBindingConfig(topicConfig.bindings?.acp);
  if (!binding) {
    return null;
  }
  return {
    topicConfig,
    binding,
    chatId: parsed.chatId,
    topicId: parsed.topicId,
    canonicalConversationId: parsed.canonicalConversationId,
  };
}

function toConfiguredBindingSpec(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  binding: AcpBindingConfigShape;
}): ConfiguredAcpBindingSpec {
  const accountId = normalizeAccountId(params.accountId);
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  return {
    channel: params.channel,
    accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
    agentId,
    mode: normalizeMode(params.binding.mode),
    cwd: params.binding.cwd,
    backend: params.binding.backend,
    label: params.binding.label,
  };
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const channel = params.channel.trim().toLowerCase();
  const accountId = normalizeAccountId(params.accountId);
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!conversationId) {
    return null;
  }

  if (channel === "discord") {
    const resolved = findDiscordChannelBinding({
      cfg: params.cfg,
      accountId,
      conversationCandidates: [conversationId, parentConversationId].filter(
        (value): value is string => Boolean(value),
      ),
    });
    if (!resolved) {
      return null;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: "discord",
      accountId,
      conversationId: resolved.channelId,
      binding: resolved.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }

  if (channel === "telegram") {
    const resolved = findTelegramTopicBinding({
      cfg: params.cfg,
      accountId,
      conversationId,
      parentConversationId,
    });
    if (!resolved) {
      return null;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: "telegram",
      accountId,
      conversationId: resolved.canonicalConversationId,
      parentConversationId: resolved.chatId,
      binding: resolved.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }

  return null;
}

function sessionMatchesConfiguredBinding(params: {
  cfg: OpenClawConfig;
  spec: ConfiguredAcpBindingSpec;
  meta: SessionAcpMeta;
}): boolean {
  const desiredAgent = params.spec.agentId.trim().toLowerCase();
  const currentAgent = (params.meta.agent ?? "").trim().toLowerCase();
  if (!currentAgent || currentAgent !== desiredAgent) {
    return false;
  }

  if (params.meta.mode !== params.spec.mode) {
    return false;
  }

  const desiredBackend = params.spec.backend?.trim() || params.cfg.acp?.backend?.trim() || "";
  if (desiredBackend) {
    const currentBackend = (params.meta.backend ?? "").trim();
    if (!currentBackend || currentBackend !== desiredBackend) {
      return false;
    }
  }

  const desiredCwd = params.spec.cwd?.trim();
  if (desiredCwd !== undefined) {
    const currentCwd = (params.meta.runtimeOptions?.cwd ?? params.meta.cwd ?? "").trim();
    if (desiredCwd !== currentCwd) {
      return false;
    }
  }
  return true;
}

export async function ensureConfiguredAcpBindingSession(params: {
  cfg: OpenClawConfig;
  spec: ConfiguredAcpBindingSpec;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; sessionKey: string; error: string }> {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  const acpManager = getAcpSessionManager();
  try {
    const resolution = acpManager.resolveSession({
      cfg: params.cfg,
      sessionKey,
    });
    if (
      resolution.kind === "ready" &&
      sessionMatchesConfiguredBinding({
        cfg: params.cfg,
        spec: params.spec,
        meta: resolution.meta,
      })
    ) {
      return {
        ok: true,
        sessionKey,
      };
    }

    if (resolution.kind !== "none") {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey,
        reason: "config-binding-reconfigure",
        clearMeta: true,
        allowBackendUnavailable: true,
        requireAcpSession: false,
      });
    }

    await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: params.spec.agentId,
      mode: params.spec.mode,
      cwd: params.spec.cwd,
      backendId: params.spec.backend,
    });

    return {
      ok: true,
      sessionKey,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVerbose(
      `acp-persistent-binding: failed ensuring ${params.spec.channel}:${params.spec.accountId}:${params.spec.conversationId} -> ${sessionKey}: ${message}`,
    );
    return {
      ok: false,
      sessionKey,
      error: message,
    };
  }
}

export async function resetAcpSessionInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
}): Promise<{ ok: true } | { ok: false; skipped?: boolean; error?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {
      ok: false,
      skipped: true,
    };
  }

  const meta = readAcpSessionEntry({
    cfg: params.cfg,
    sessionKey,
  })?.acp;
  if (!meta) {
    return {
      ok: false,
      skipped: true,
    };
  }

  const acpManager = getAcpSessionManager();
  const agent = pickFirstExistingAgentId(params.cfg, meta.agent || "main");
  const mode = meta.mode === "oneshot" ? "oneshot" : "persistent";
  const runtimeOptions = { ...meta.runtimeOptions };
  const cwd = normalizeText(runtimeOptions.cwd ?? meta.cwd);

  try {
    await acpManager.closeSession({
      cfg: params.cfg,
      sessionKey,
      reason: `${params.reason}-in-place-reset`,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });

    await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent,
      mode,
      cwd,
      backendId: normalizeText(meta.backend) ?? normalizeText(params.cfg.acp?.backend),
    });

    const runtimeOptionsPatch = Object.fromEntries(
      Object.entries(runtimeOptions).filter(([, value]) => value !== undefined),
    ) as SessionAcpMeta["runtimeOptions"];
    if (runtimeOptionsPatch && Object.keys(runtimeOptionsPatch).length > 0) {
      await acpManager.updateSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey,
        patch: runtimeOptionsPatch,
      });
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVerbose(`acp-persistent-binding: failed reset for ${sessionKey}: ${message}`);
    return {
      ok: false,
      error: message,
    };
  }
}
