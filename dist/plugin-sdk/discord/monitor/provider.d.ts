import { resolveThreadBindingsEnabled } from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig, ReplyToMode } from "../../config/config.js";
import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import { type RuntimeEnv } from "../../runtime.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import type { DiscordMonitorStatusSink } from "./status.js";
export type MonitorDiscordOpts = {
    token?: string;
    accountId?: string;
    config?: OpenClawConfig;
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    mediaMaxMb?: number;
    historyLimit?: number;
    replyToMode?: ReplyToMode;
    setStatus?: DiscordMonitorStatusSink;
};
export declare function monitorDiscordProvider(opts?: MonitorDiscordOpts): Promise<void>;
export declare const __testing: {
    createDiscordGatewayPlugin: typeof createDiscordGatewayPlugin;
    resolveDiscordRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
    resolveDiscordRestFetch: typeof resolveDiscordRestFetch;
    resolveThreadBindingsEnabled: typeof resolveThreadBindingsEnabled;
};
