export type { AllowlistMatch, AllowlistMatchSource, CompiledAllowlist, } from "../channels/allowlist-match.js";
export type { AllowlistUserResolutionLike } from "../channels/allowlists/resolve-utils.js";
export { compileAllowlist, formatAllowlistMatchMeta, resolveAllowlistCandidates, resolveAllowlistMatchByCandidates, resolveAllowlistMatchSimple, resolveCompiledAllowlistMatch, } from "../channels/allowlist-match.js";
export { firstDefined, isSenderIdAllowed, mergeDmAllowFromSources, resolveGroupAllowFromSources, } from "../channels/allow-from.js";
export { addAllowlistUserEntriesFromConfigEntry, buildAllowlistResolutionSummary, canonicalizeAllowlistWithResolvedIds, mergeAllowlist, patchAllowlistUsersInConfigEntries, summarizeMapping, } from "../channels/allowlists/resolve-utils.js";
/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
export declare function formatAllowFromLowercase(params: {
    allowFrom: Array<string | number>;
    stripPrefixRe?: RegExp;
}): string[];
/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
export declare function formatNormalizedAllowFromEntries(params: {
    allowFrom: Array<string | number>;
    normalizeEntry: (entry: string) => string | undefined | null;
}): string[];
/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export declare function isNormalizedSenderAllowed(params: {
    senderId: string | number;
    allowFrom: Array<string | number>;
    stripPrefixRe?: RegExp;
}): boolean;
type ParsedChatAllowTarget = {
    kind: "chat_id";
    chatId: number;
} | {
    kind: "chat_guid";
    chatGuid: string;
} | {
    kind: "chat_identifier";
    chatIdentifier: string;
} | {
    kind: "handle";
    handle: string;
};
/** Match chat-aware allowlist entries against sender, chat id, guid, or identifier fields. */
export declare function isAllowedParsedChatSender(params: {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
    normalizeSender: (sender: string) => string;
    parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean;
export type BasicAllowlistResolutionEntry = {
    input: string;
    resolved: boolean;
    id?: string;
    name?: string;
    note?: string;
};
/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
export declare function mapBasicAllowlistResolutionEntries(entries: BasicAllowlistResolutionEntry[]): BasicAllowlistResolutionEntry[];
/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
export declare function mapAllowlistResolutionInputs<T>(params: {
    inputs: string[];
    mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]>;
