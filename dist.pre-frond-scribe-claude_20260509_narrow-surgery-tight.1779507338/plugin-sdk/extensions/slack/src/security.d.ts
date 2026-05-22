import { type ResolvedSlackAccount } from "./accounts.js";
export declare const slackSecurityAdapter: {
    resolveDmPolicy: ({ cfg, accountId, account, }: {
        cfg: import("./channel-api.js").OpenClawConfig;
        accountId?: string | null;
        account: ResolvedSlackAccount;
    }) => import("openclaw/plugin-sdk/channel-runtime").ChannelSecurityDmPolicy;
    collectWarnings: (params: {
        account: ResolvedSlackAccount;
        cfg: import("./channel-api.js").OpenClawConfig;
    }) => string[];
    collectAuditFindings: (params: import("openclaw/plugin-sdk/channel-runtime").ChannelSecurityContext<ResolvedSlackAccount> & {
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
