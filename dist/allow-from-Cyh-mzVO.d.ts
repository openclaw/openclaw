import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/channels/allowlists/resolve-utils.d.ts
type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};
declare function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[];
declare function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(resolvedUsers: T[], opts?: {
  formatResolved?: (entry: T) => string;
  formatUnresolved?: (entry: T) => string;
}): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
  additions: string[];
};
declare function canonicalizeAllowlistWithResolvedIds<T extends AllowlistUserResolutionLike>(params: {
  existing?: Array<string | number>;
  resolvedMap: Map<string, T>;
}): string[];
declare function patchAllowlistUsersInConfigEntries<T extends AllowlistUserResolutionLike, TEntries extends Record<string, unknown>>(params: {
  entries: TEntries;
  resolvedMap: Map<string, T>;
  strategy?: "merge" | "canonicalize";
}): TEntries;
declare function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void;
declare function summarizeMapping(label: string, mapping: string[], unresolved: string[], runtime: RuntimeEnv): void;
//#endregion
//#region src/plugin-sdk/allow-from.d.ts
/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
declare function formatAllowFromLowercase(params: {
  allowFrom: Array<string | number>;
  stripPrefixRe?: RegExp;
}): string[];
/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
declare function formatNormalizedAllowFromEntries(params: {
  allowFrom: Array<string | number>;
  normalizeEntry: (entry: string) => string | undefined | null;
}): string[];
/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
declare function isNormalizedSenderAllowed(params: {
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
/** Match allowlist entries against senders, with conversation targets requiring explicit opt-in. */
declare function isAllowedParsedChatSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  allowConversationTargets?: boolean | null;
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean;
type BasicAllowlistResolutionEntry = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};
/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
declare function mapBasicAllowlistResolutionEntries(entries: BasicAllowlistResolutionEntry[]): BasicAllowlistResolutionEntry[];
/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
declare function mapAllowlistResolutionInputs<T>(params: {
  inputs: string[];
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]>;
//#endregion
export { isNormalizedSenderAllowed as a, AllowlistUserResolutionLike as c, canonicalizeAllowlistWithResolvedIds as d, mergeAllowlist as f, isAllowedParsedChatSender as i, addAllowlistUserEntriesFromConfigEntry as l, summarizeMapping as m, formatAllowFromLowercase as n, mapAllowlistResolutionInputs as o, patchAllowlistUsersInConfigEntries as p, formatNormalizedAllowFromEntries as r, mapBasicAllowlistResolutionEntries as s, BasicAllowlistResolutionEntry as t, buildAllowlistResolutionSummary as u };