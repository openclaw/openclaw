import { type ResolvedDiscordAccount } from "./accounts.js";
export declare const discordSecurityAdapter: {
    resolveDmPolicy: ({ cfg, accountId, account, }: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId?: string | null;
        account: ResolvedDiscordAccount;
    }) => import("openclaw/plugin-sdk/channel-runtime").ChannelSecurityDmPolicy;
    collectWarnings: (params: {
        account: ResolvedDiscordAccount;
        cfg: import("./channel-api.js").OpenClawConfig;
    }) => string[];
    collectAuditFindings: (params: import("openclaw/plugin-sdk/channel-runtime").ChannelSecurityContext<ResolvedDiscordAccount> & {
        sourceConfig: import("./channel-api.js").OpenClawConfig;
        orderedAccountIds: string[];
        hasExplicitAccountPath: boolean;
    }) => Promise<{
        checkId: string;
        severity: "info" | "warn" | "critical";
        title: string;
        detail: string;
        remediation?: string;
    }[]>;
};
