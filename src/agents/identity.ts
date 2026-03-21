import type { OpenClawConfig, HumanDelayConfig, IdentityConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_ACK_REACTION = "👀";

export function resolveAgentIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): IdentityConfig | undefined {
  return resolveAgentConfig(cfg, agentId)?.identity;
}

export function resolveAckReaction(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string {
  // L1: Channel account level
  if (opts?.channel && opts?.accountId) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountReaction = extractAckEmoji(accounts?.[opts.accountId]?.ackReaction);
    if (accountReaction !== undefined) {
      return accountReaction.trim();
    }
  }

  // L2: Channel level
  if (opts?.channel) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const channelReaction = extractAckEmoji(channelCfg?.ackReaction);
    if (channelReaction !== undefined) {
      return channelReaction.trim();
    }
  }

  // L3: Global messages level
  const configured = cfg.messages?.ackReaction;
  if (configured !== undefined) {
    return configured.trim();
  }

  // L4: Agent identity emoji fallback
  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || DEFAULT_ACK_REACTION;
}

export function resolveIdentityNamePrefix(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const name = resolveAgentIdentity(cfg, agentId)?.name?.trim();
  if (!name) {
    return undefined;
  }
  return `[${name}]`;
}

/** Returns just the identity name (without brackets) for template context. */
export function resolveIdentityName(cfg: OpenClawConfig, agentId: string): string | undefined {
  return resolveAgentIdentity(cfg, agentId)?.name?.trim() || undefined;
}

export function resolveMessagePrefix(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { configured?: string; hasAllowFrom?: boolean; fallback?: string },
): string {
  const configured = opts?.configured ?? cfg.messages?.messagePrefix;
  if (configured !== undefined) {
    return configured;
  }

  const hasAllowFrom = opts?.hasAllowFrom === true;
  if (hasAllowFrom) {
    return "";
  }

  return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[openclaw]";
}

/** Extracts the ack emoji from either a plain string or an object with an `emoji` field. */
function extractAckEmoji(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "emoji" in value) {
    const emoji = (value as { emoji?: unknown }).emoji;
    return typeof emoji === "string" ? emoji : undefined;
  }
  return undefined;
}

/**
 * Resolves the ack reaction emoji for a WhatsApp message, scoped to the responding agent.
 *
 * Resolution order (most to least specific):
 *   L1: channels.whatsapp.accounts[accountId].ackReaction.emoji
 *   L2: channels.whatsapp.ackReaction.emoji
 *   L4: agent identity emoji
 *
 * Intentionally skips the global messages.ackReaction (L3) — that field is a plain
 * string used by channels with a flat ack config; mixing it into WhatsApp's object-format
 * ackReaction would silently change behaviour for users who set messages.ackReaction for
 * other channels but leave WhatsApp ackReaction.emoji unset.
 *
 * Returns "" (no reaction) when channels.whatsapp.ackReaction is absent at both the
 * channel and account level, preserving the existing default of no reaction for
 * unconfigured WhatsApp setups.
 */
export function resolveWhatsAppAckEmoji(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { accountId?: string },
): string {
  const waConfig = (cfg.channels as Record<string, unknown> | undefined)?.whatsapp as
    | Record<string, unknown>
    | undefined;

  const accounts = waConfig?.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountAck = opts?.accountId ? accounts?.[opts.accountId]?.ackReaction : undefined;

  // Preserve existing default: no ackReaction config at either level → no reaction.
  if (!waConfig?.ackReaction && accountAck === undefined) {
    return "";
  }

  // L1: account-level ackReaction takes full precedence when present.
  // If account ackReaction is configured but has no emoji, skip channel-level and
  // fall directly to agent identity — account config wins at its level.
  if (accountAck !== undefined) {
    const accountEmoji = extractAckEmoji(accountAck);
    if (accountEmoji !== undefined) {
      return accountEmoji.trim();
    }
    return resolveAgentIdentity(cfg, agentId)?.emoji?.trim() ?? "";
  }

  // L2: channel-level ackReaction.emoji
  const channelEmoji = extractAckEmoji(waConfig?.ackReaction);
  if (channelEmoji !== undefined) {
    return channelEmoji.trim();
  }

  // L4: agent identity emoji — enables per-agent ack reactions when ackReaction is
  // configured but emoji is intentionally left unset.
  // L3 (messages.ackReaction) is skipped: see function doc.
  return resolveAgentIdentity(cfg, agentId)?.emoji?.trim() ?? "";
}

/** Helper to extract a channel config value by dynamic key. */
function getChannelConfig(
  cfg: OpenClawConfig,
  channel: string,
): Record<string, unknown> | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const value = channels?.[channel];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveResponsePrefix(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string | undefined {
  // L1: Channel account level
  if (opts?.channel && opts?.accountId) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountPrefix = accounts?.[opts.accountId]?.responsePrefix as string | undefined;
    if (accountPrefix !== undefined) {
      if (accountPrefix === "auto") {
        return resolveIdentityNamePrefix(cfg, agentId);
      }
      return accountPrefix;
    }
  }

  // L2: Channel level
  if (opts?.channel) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const channelPrefix = channelCfg?.responsePrefix as string | undefined;
    if (channelPrefix !== undefined) {
      if (channelPrefix === "auto") {
        return resolveIdentityNamePrefix(cfg, agentId);
      }
      return channelPrefix;
    }
  }

  // L4: Global level
  const configured = cfg.messages?.responsePrefix;
  if (configured !== undefined) {
    if (configured === "auto") {
      return resolveIdentityNamePrefix(cfg, agentId);
    }
    return configured;
  }
  return undefined;
}

export function resolveEffectiveMessagesConfig(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: {
    hasAllowFrom?: boolean;
    fallbackMessagePrefix?: string;
    channel?: string;
    accountId?: string;
  },
): { messagePrefix: string; responsePrefix?: string } {
  return {
    messagePrefix: resolveMessagePrefix(cfg, agentId, {
      hasAllowFrom: opts?.hasAllowFrom,
      fallback: opts?.fallbackMessagePrefix,
    }),
    responsePrefix: resolveResponsePrefix(cfg, agentId, {
      channel: opts?.channel,
      accountId: opts?.accountId,
    }),
  };
}

export function resolveHumanDelayConfig(
  cfg: OpenClawConfig,
  agentId: string,
): HumanDelayConfig | undefined {
  const defaults = cfg.agents?.defaults?.humanDelay;
  const overrides = resolveAgentConfig(cfg, agentId)?.humanDelay;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    mode: overrides?.mode ?? defaults?.mode,
    minMs: overrides?.minMs ?? defaults?.minMs,
    maxMs: overrides?.maxMs ?? defaults?.maxMs,
  };
}
