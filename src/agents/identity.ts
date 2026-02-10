import type { OpenClawConfig, HumanDelayConfig, IdentityConfig } from "../config/config.js";
import { resolveAckReactionChoice } from "../channels/ack-reactions.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_ACK_REACTION = "👀";

export function resolveAgentIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): IdentityConfig | undefined {
  return resolveAgentConfig(cfg, agentId)?.identity;
}

export function resolveAckReaction(cfg: OpenClawConfig, agentId: string): string {
  const choice = resolveAckReactionChoice(cfg.messages?.ackReaction);
  if (choice.configured) {
    return choice.value;
  }
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
