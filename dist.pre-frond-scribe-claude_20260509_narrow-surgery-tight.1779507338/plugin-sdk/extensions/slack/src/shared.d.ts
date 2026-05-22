import { type ResolvedSlackAccount } from "./accounts.js";
import { type ChannelPlugin } from "./channel-api.js";
export { setSlackChannelAllowlist, SLACK_CHANNEL } from "./setup-shared.js";
export declare function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean;
export declare const slackConfigAdapter: {
    listAccountIds: (cfg: import("./channel-api.js").OpenClawConfig) => string[];
    resolveAccount: (cfg: import("./channel-api.js").OpenClawConfig, accountId?: string | null) => ResolvedSlackAccount;
    inspectAccount?: (cfg: import("./channel-api.js").OpenClawConfig, accountId?: string | null) => unknown;
    defaultAccountId?: (cfg: import("./channel-api.js").OpenClawConfig) => string;
    setAccountEnabled?: (params: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId: string;
        enabled: boolean;
    }) => import("./channel-api.js").OpenClawConfig;
    deleteAccount?: (params: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId: string;
    }) => import("./channel-api.js").OpenClawConfig;
    resolveAllowFrom?: (params: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId?: string | null;
    }) => Array<string | number> | undefined;
    formatAllowFrom?: (params: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
    }) => string[];
    resolveDefaultTo?: (params: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId?: string | null;
    }) => string | undefined;
};
export declare function createSlackPluginBase(params: {
    setupWizard: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupWizard"]>;
    setup: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setup"]>;
}): Pick<ChannelPlugin<ResolvedSlackAccount>, "id" | "meta" | "setupWizard" | "capabilities" | "commands" | "doctor" | "agentPrompt" | "streaming" | "reload" | "configSchema" | "config" | "setup" | "security" | "secrets">;
