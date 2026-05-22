import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ResolvedReactionLevel } from "openclaw/plugin-sdk/status-helpers";
type ResolvedWhatsAppReactionLevel = ResolvedReactionLevel;
/** Resolve the effective reaction level and its implications for WhatsApp. */
export declare function resolveWhatsAppReactionLevel(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): ResolvedWhatsAppReactionLevel;
export {};
