import type { WebClient } from "@slack/web-api";
export type SlackChannelLookup = {
    id: string;
    name: string;
    archived: boolean;
    isPrivate: boolean;
};
export type SlackChannelResolution = {
    input: string;
    resolved: boolean;
    id?: string;
    name?: string;
    archived?: boolean;
};
export declare function resolveSlackChannelAllowlist(params: {
    token: string;
    entries: string[];
    client?: WebClient;
}): Promise<SlackChannelResolution[]>;
