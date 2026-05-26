import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { v as HumanDelayConfig, y as IdentityConfig } from "./types.base-DS--yneR.js";

//#region src/agents/identity.d.ts
declare function resolveAgentIdentity(cfg: OpenClawConfig, agentId: string): IdentityConfig | undefined;
declare function resolveAckReaction(cfg: OpenClawConfig, agentId: string, opts?: {
  channel?: string;
  accountId?: string;
}): string;
declare function resolveIdentityNamePrefix(cfg: OpenClawConfig, agentId: string): string | undefined;
declare function resolveMessagePrefix(cfg: OpenClawConfig, agentId: string, opts?: {
  configured?: string;
  hasAllowFrom?: boolean;
  fallback?: string;
}): string;
declare function resolveResponsePrefix(cfg: OpenClawConfig, agentId: string, opts?: {
  channel?: string;
  accountId?: string;
}): string | undefined;
declare function resolveEffectiveMessagesConfig(cfg: OpenClawConfig, agentId: string, opts?: {
  hasAllowFrom?: boolean;
  fallbackMessagePrefix?: string;
  channel?: string;
  accountId?: string;
}): {
  messagePrefix: string;
  responsePrefix?: string;
};
declare function resolveHumanDelayConfig(cfg: OpenClawConfig, agentId: string): HumanDelayConfig | undefined;
//#endregion
export { resolveIdentityNamePrefix as a, resolveHumanDelayConfig as i, resolveAgentIdentity as n, resolveMessagePrefix as o, resolveEffectiveMessagesConfig as r, resolveResponsePrefix as s, resolveAckReaction as t };