import { type OpenClawConfig } from "../config/config.js";
import { type SessionEntry, type SessionScope } from "../config/sessions.js";
import type { GatewayAgentRow, GatewaySessionRow, GatewaySessionsDefaults, SessionsListResult } from "./session-utils.types.js";
export { archiveFileOnDisk, archiveSessionTranscripts, capArrayByJsonBytes, readFirstUserMessageFromTranscript, readLastMessagePreviewFromTranscript, readSessionTitleFieldsFromTranscript, readSessionPreviewItemsFromTranscript, readSessionMessages, resolveSessionTranscriptCandidates, } from "./session-utils.fs.js";
export type { GatewayAgentRow, GatewaySessionRow, GatewaySessionsDefaults, SessionsListResult, SessionsPatchResult, SessionsPreviewEntry, SessionsPreviewResult, } from "./session-utils.types.js";
export declare function deriveSessionTitle(entry: SessionEntry | undefined, firstUserMessage?: string | null): string | undefined;
export declare function loadSessionEntry(sessionKey: string): {
    cfg: OpenClawConfig;
    storePath: string;
    store: Record<string, SessionEntry>;
    entry: SessionEntry | undefined;
    canonicalKey: string;
    legacyKey: string | undefined;
};
/**
 * Find all on-disk store keys that match the given key case-insensitively.
 * Returns every key from the store whose lowercased form equals the target's lowercased form.
 */
export declare function findStoreKeysIgnoreCase(store: Record<string, unknown>, targetKey: string): string[];
/**
 * Remove legacy key variants for one canonical session key.
 * Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
 */
export declare function pruneLegacyStoreKeys(params: {
    store: Record<string, unknown>;
    canonicalKey: string;
    candidates: Iterable<string>;
}): void;
export declare function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"];
export declare function parseGroupKey(key: string): {
    channel?: string;
    kind?: "group" | "channel";
    id?: string;
} | null;
export declare function listAgentsForGateway(cfg: OpenClawConfig): {
    defaultId: string;
    mainKey: string;
    scope: SessionScope;
    agents: GatewayAgentRow[];
};
export declare function resolveSessionStoreKey(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
}): string;
export declare function canonicalizeSpawnedByForAgent(cfg: OpenClawConfig, agentId: string, spawnedBy?: string): string | undefined;
export declare function resolveGatewaySessionStoreTarget(params: {
    cfg: OpenClawConfig;
    key: string;
    scanLegacyKeys?: boolean;
    store?: Record<string, SessionEntry>;
}): {
    agentId: string;
    storePath: string;
    canonicalKey: string;
    storeKeys: string[];
};
export declare function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig): {
    storePath: string;
    store: Record<string, SessionEntry>;
};
export declare function getSessionDefaults(cfg: OpenClawConfig): GatewaySessionsDefaults;
export declare function resolveSessionModelRef(cfg: OpenClawConfig, entry?: SessionEntry | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">, agentId?: string): {
    provider: string;
    model: string;
};
export declare function resolveSessionModelIdentityRef(cfg: OpenClawConfig, entry?: SessionEntry | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">, agentId?: string): {
    provider?: string;
    model: string;
};
export declare function listSessionsFromStore(params: {
    cfg: OpenClawConfig;
    storePath: string;
    store: Record<string, SessionEntry>;
    opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult;
