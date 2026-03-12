import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import type { OpenClawConfig, ReplyToMode } from "../../config/config.js";
import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import { type RuntimeEnv } from "../../runtime.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
export type MonitorDiscordOpts = {
    token?: string;
    accountId?: string;
    config?: OpenClawConfig;
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    mediaMaxMb?: number;
    historyLimit?: number;
    replyToMode?: ReplyToMode;
};
declare function resolveThreadBindingsEnabled(params: {
    channelEnabledRaw: unknown;
    sessionEnabledRaw: unknown;
}): boolean;
declare function dedupeSkillCommandsForDiscord(skillCommands: ReturnType<typeof listSkillCommandsForAgents>): import("../../agents/skills.ts").SkillCommandSpec[];
export declare function monitorDiscordProvider(opts?: MonitorDiscordOpts): Promise<void>;
export declare const __testing: {
    createDiscordGatewayPlugin: typeof createDiscordGatewayPlugin;
    dedupeSkillCommandsForDiscord: typeof dedupeSkillCommandsForDiscord;
    resolveDiscordRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
    resolveDiscordRestFetch: typeof resolveDiscordRestFetch;
    resolveThreadBindingsEnabled: typeof resolveThreadBindingsEnabled;
};
export {};
