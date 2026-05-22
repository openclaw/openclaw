import { type SessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { ThreadBindingManager } from "./thread-bindings.types.js";
type ThreadBindingDefaults = {
    idleTimeoutMs: number;
    maxAgeMs: number;
};
export declare function createThreadBindingSessionAdapter(params: {
    accountId: string;
    manager: ThreadBindingManager;
    defaults: ThreadBindingDefaults;
    resolveCurrentCfg: () => OpenClawConfig;
    resolveCurrentToken: () => string | undefined;
}): SessionBindingAdapter;
export {};
