import type { WebClient } from "@slack/web-api";
export type SlackUserLookup = {
    id: string;
    name: string;
    displayName?: string;
    realName?: string;
    email?: string;
    deleted: boolean;
    isBot: boolean;
    isAppUser: boolean;
};
export type SlackUserResolution = {
    input: string;
    resolved: boolean;
    id?: string;
    name?: string;
    email?: string;
    deleted?: boolean;
    isBot?: boolean;
    note?: string;
};
export declare function resolveSlackUserAllowlist(params: {
    token: string;
    entries: string[];
    client?: WebClient;
}): Promise<SlackUserResolution[]>;
