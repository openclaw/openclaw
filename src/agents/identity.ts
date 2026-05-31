import type { HumanDelayConfig, IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_ACK_REACTION = "👀";

/** Returns the configured identity block for an agent, after default-agent resolution. */
export function resolveAgentIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): IdentityConfig | undefined {
  return resolveAgentConfig(cfg, agentId)?.identity;
}

/** Resolves the acknowledgement reaction using account, channel, global, then identity fallback precedence. */
export function resolveAckReaction(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string {
  // Account-level channel config wins because the same provider can host multiple differently-branded accounts.
  if (opts?.channel && opts?.accountId) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountReaction = accounts?.[opts.accountId]?.ackReaction as string | undefined;
    if (accountReaction !== undefined) {
      return accountReaction.trim();
    }
  }

  // Channel-wide config is shared across accounts but still more specific than global message defaults.
  if (opts?.channel) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    const channelReaction = channelCfg?.ackReaction as string | undefined;
    if (channelReaction !== undefined) {
      return channelReaction.trim();
    }
  }

  const configured = cfg.messages?.ackReaction;
  if (configured !== undefined) {
    return configured.trim();
  }

  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || DEFAULT_ACK_REACTION;
}

/** Converts an agent identity name into the bracketed prefix used by outbound messages. */
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

/** Resolves the outbound message prefix, preserving explicit empty strings for allow-from flows. */
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

/** Resolves response-prefix overrides where the special `auto` value expands to the agent identity name. */
export function resolveResponsePrefix(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string | undefined {
  // Account overrides are checked first so multi-account channels can opt into separate visible identities.
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

  // Channel-level `auto` keeps plugin config concise while still deriving the current agent name.
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

  const configured = cfg.messages?.responsePrefix;
  if (configured !== undefined) {
    if (configured === "auto") {
      return resolveIdentityNamePrefix(cfg, agentId);
    }
    return configured;
  }
  return undefined;
}

/** Projects the message-prefix and response-prefix rules into the compact shape used by channel senders. */
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

/** Merges global human-delay defaults with per-agent overrides while preserving unset fields. */
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
