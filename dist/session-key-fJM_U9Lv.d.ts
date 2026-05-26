//#region src/sessions/session-key-utils.d.ts
type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};
type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};
/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are canonicalized for stable comparisons/routing while
 * preserving provider-owned opaque peer IDs.
 */
declare function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null;
declare function isCronSessionKey(sessionKey: string | undefined | null): boolean;
declare function isSubagentSessionKey(sessionKey: string | undefined | null): boolean;
declare function isAcpSessionKey(sessionKey: string | undefined | null): boolean;
declare function parseThreadSessionSuffix(sessionKey: string | undefined | null): ParsedThreadSessionSuffix;
//#endregion
//#region src/routing/session-key.d.ts
declare const DEFAULT_MAIN_KEY = "main";
declare function normalizeMainKey(value: string | undefined | null): string;
declare function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string;
declare function normalizeAgentId(value: string | undefined | null): string;
declare function sanitizeAgentId(value: string | undefined | null): string;
declare function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string;
declare function buildGroupHistoryKey(params: {
  channel: string;
  accountId?: string | null;
  peerKind: "group" | "channel";
  peerId: string;
}): string;
declare function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
  normalizeThreadId?: (threadId: string) => string;
}): {
  sessionKey: string;
  parentSessionKey?: string;
};
//#endregion
export { normalizeMainKey as a, sanitizeAgentId as c, isCronSessionKey as d, isSubagentSessionKey as f, normalizeAgentId as i, ParsedAgentSessionKey as l, parseThreadSessionSuffix as m, buildAgentMainSessionKey as n, resolveAgentIdFromSessionKey as o, parseAgentSessionKey as p, buildGroupHistoryKey as r, resolveThreadSessionKeys as s, DEFAULT_MAIN_KEY as t, isAcpSessionKey as u };