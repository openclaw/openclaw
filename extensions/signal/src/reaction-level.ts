import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveSignalAccount } from "./accounts.js";

export type SignalReactionLevel = ReactionLevel;
export type ResolvedSignalReactionLevel = ResolvedReactionLevel;

export function resolveSignalReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedSignalReactionLevel {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "minimal",
  });
}
