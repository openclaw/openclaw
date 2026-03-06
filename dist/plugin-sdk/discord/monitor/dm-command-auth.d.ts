import { type DmGroupAccessDecision } from "../../security/dm-policy-shared.js";
import { resolveDiscordAllowListMatch } from "./allow-list.js";
export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export type DiscordDmCommandAccess = {
    decision: DmGroupAccessDecision;
    reason: string;
    commandAuthorized: boolean;
    allowMatch: ReturnType<typeof resolveDiscordAllowListMatch> | {
        allowed: false;
    };
};
export declare function resolveDiscordDmCommandAccess(params: {
    accountId: string;
    dmPolicy: DiscordDmPolicy;
    configuredAllowFrom: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching: boolean;
    useAccessGroups: boolean;
    readStoreAllowFrom?: () => Promise<string[]>;
}): Promise<DiscordDmCommandAccess>;
