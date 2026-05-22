import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { formatInboundEnvelope, type EnvelopeFormatOptions, } from "openclaw/plugin-sdk/channel-envelope";
type WhatsAppMessagePrefixConfig = OpenClawConfig;
export declare function resolveMessagePrefix(cfg: WhatsAppMessagePrefixConfig, agentId: string, opts?: {
    configured?: string;
    hasAllowFrom?: boolean;
    fallback?: string;
}): string;
