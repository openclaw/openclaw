import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasUnresolvedConfigValue } from "openclaw/plugin-sdk/gateway-config-runtime";
import type { A2aChannelConfig, ResolvedA2aChannelAccount } from "./types.js";

export function listA2aChannelAccountIds(cfg: OpenClawConfig): string[] {
  return cfg.channels?.a2a ? [DEFAULT_ACCOUNT_ID] : [];
}

export function resolveDefaultA2aChannelAccountId(): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * A `${VAR}` token reference whose variable is unset stays in config as literal
 * text, so it must never act as a credential: a caller could send that guessable
 * text as the bearer. Drop such peers (and such outbound tokens) so every consumer
 * sees them as unconfigured.
 */
function withoutUnresolvedCredentials(cfg: OpenClawConfig, config: A2aChannelConfig) {
  const unresolvedPeers: string[] = [];
  const peers = config.peers;
  if (!peers) {
    return { config, unresolvedPeers };
  }
  const available: NonNullable<A2aChannelConfig["peers"]> = {};
  for (const [peerName, peer] of Object.entries(peers)) {
    const base = ["channels", "a2a", "peers", peerName] as const;
    if (hasUnresolvedConfigValue(cfg, [...base, "token"])) {
      unresolvedPeers.push(peerName);
      continue;
    }
    if (peer.outboundToken && hasUnresolvedConfigValue(cfg, [...base, "outboundToken"])) {
      const { outboundToken: _unresolved, ...rest } = peer;
      available[peerName] = rest;
      continue;
    }
    available[peerName] = peer;
  }
  return { config: { ...config, peers: available }, unresolvedPeers };
}

export function resolveA2aChannelAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedA2aChannelAccount {
  const { config, unresolvedPeers } = withoutUnresolvedCredentials(
    params.cfg,
    params.cfg.channels?.a2a ?? {},
  );
  return {
    accountId: normalizeAccountId(params.accountId),
    enabled: config.enabled !== false,
    configured: Object.keys(config.peers ?? {}).length > 0,
    config,
    unresolvedPeers,
  };
}

export { DEFAULT_ACCOUNT_ID };
