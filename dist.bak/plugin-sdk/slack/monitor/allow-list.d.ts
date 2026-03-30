import type { AllowlistMatch } from "../../channels/allowlist-match.js";
export declare function normalizeSlackSlug(raw?: string): string;
export declare function normalizeAllowList(list?: Array<string | number>): string[];
export declare function normalizeAllowListLower(list?: Array<string | number>): string[];
export type SlackAllowListMatch = AllowlistMatch<"wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug">;
export declare function resolveSlackAllowListMatch(params: {
    allowList: string[];
    id?: string;
    name?: string;
    allowNameMatching?: boolean;
}): SlackAllowListMatch;
export declare function allowListMatches(params: {
    allowList: string[];
    id?: string;
    name?: string;
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveSlackUserAllowed(params: {
    allowList?: Array<string | number>;
    userId?: string;
    userName?: string;
    allowNameMatching?: boolean;
}): boolean;
