import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type WhatsAppSocketTimingOptions = {
    keepAliveIntervalMs?: number;
    connectTimeoutMs?: number;
    defaultQueryTimeoutMs?: number;
};
export declare const DEFAULT_WHATSAPP_SOCKET_TIMING: Required<WhatsAppSocketTimingOptions>;
export declare function resolveWhatsAppSocketTiming(cfg: OpenClawConfig, overrides?: WhatsAppSocketTimingOptions): Required<WhatsAppSocketTimingOptions>;
