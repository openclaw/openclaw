import { resolveThreadBindingIdleTimeoutMs, resolveThreadBindingMaxAgeMs, resolveThreadBindingsEnabled } from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
export { resolveThreadBindingIdleTimeoutMs, resolveThreadBindingMaxAgeMs, resolveThreadBindingsEnabled, };
export declare function resolveDiscordThreadBindingIdleTimeoutMs(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): number;
export declare function resolveDiscordThreadBindingMaxAgeMs(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): number;
