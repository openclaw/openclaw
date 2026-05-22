import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingsEnabled } from "openclaw/plugin-sdk/conversation-runtime";
export { resolveThreadBindingsEnabled };
export declare function resolveDiscordThreadBindingIdleTimeoutMs(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): number;
export declare function resolveDiscordThreadBindingMaxAgeMs(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): number;
