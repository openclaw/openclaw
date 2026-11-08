import type { HumanDelayConfig, IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentEntry } from "./agent-scope-config.js";

const DEFAULT_ACK_REACTION = "👀";

/** Resolve the configured identity block for one agent. */
export function resolveAgentIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): IdentityConfig | undefined {
  // Keep merged-config request normalization for raw Plugin SDK agent ids.
  return resolveAgentEntry(cfg, normalizeAgentId(agentId))?.identity;
}

/** Resolve the acknowledgement reaction using account, channel, global, then identity fallback. */
export function resolveAckReaction(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string {
  const configured = resolveChannelMessageSetting(cfg, "ackReaction", opts);
  if (configured !== undefined) {
    return configured.trim();
  }

  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || DEFAULT_ACK_REACTION;
}

/** Build the automatic `[name]` prefix for an agent identity. */
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

/** Preserve explicit empty settings through account, channel, and global precedence. */
function resolveChannelMessageSetting(
  cfg: OpenClawConfig,
  key: "ackReaction" | "responsePrefix",
  opts?: { channel?: string; accountId?: string },
): string | undefined {
  if (opts?.channel) {
    const channelCfg = getChannelConfig(cfg, opts.channel);
    if (opts.accountId) {
      const accounts = channelCfg?.accounts as Record<string, Record<string, unknown>> | undefined;
      const accountValue = resolveChannelAccountEntry(
        accounts,
        opts.accountId,
        opts.channel,
        (id) => id,
      )?.[key] as string | undefined;
      if (accountValue !== undefined) {
        return accountValue;
      }
    }
    const channelValue = channelCfg?.[key] as string | undefined;
    if (channelValue !== undefined) {
      return channelValue;
    }
  }
  // Implicit and custom channels may have no block to migrate.
  return cfg.messages?.[key];
}

/** Resolve the optional response prefix, expanding `auto` to the identity name prefix. */
export function resolveResponsePrefix(
  cfg: OpenClawConfig,
  agentId: string,
  opts?: { channel?: string; accountId?: string },
): string | undefined {
  const configured = resolveChannelMessageSetting(cfg, "responsePrefix", opts);
  return configured === "auto" ? resolveIdentityNamePrefix(cfg, agentId) : configured;
}

/** Resolve message and response prefix values together for channel delivery. */
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
    messagePrefix:
      opts?.hasAllowFrom === true
        ? ""
        : (resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallbackMessagePrefix ?? "[openclaw]"),
    responsePrefix: resolveResponsePrefix(cfg, agentId, opts),
  };
}

/** Resolve per-agent human-delay settings over global agent defaults. */
export function resolveHumanDelayConfig(
  cfg: OpenClawConfig,
  agentId: string,
): HumanDelayConfig | undefined {
  const defaults = cfg.agents?.defaults?.humanDelay;
  const overrides = resolveAgentEntry(cfg, normalizeAgentId(agentId))?.humanDelay;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    mode: overrides?.mode ?? defaults?.mode,
    minMs: overrides?.minMs ?? defaults?.minMs,
    maxMs: overrides?.maxMs ?? defaults?.maxMs,
  };
}
