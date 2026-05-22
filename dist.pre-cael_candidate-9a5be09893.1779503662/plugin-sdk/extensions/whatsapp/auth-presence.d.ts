import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type WhatsAppAuthPresenceParams = {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
} | OpenClawConfig;
export declare function hasAnyWhatsAppAuth(params: WhatsAppAuthPresenceParams, env?: NodeJS.ProcessEnv): boolean;
export {};
