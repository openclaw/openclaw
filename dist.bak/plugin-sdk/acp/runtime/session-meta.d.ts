import type { OpenClawConfig } from "../../config/config.js";
import { type SessionAcpMeta, type SessionEntry } from "../../config/sessions/types.js";
export type AcpSessionStoreEntry = {
    cfg: OpenClawConfig;
    storePath: string;
    sessionKey: string;
    storeSessionKey: string;
    entry?: SessionEntry;
    acp?: SessionAcpMeta;
    storeReadFailed?: boolean;
};
export declare function resolveSessionStorePathForAcp(params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
}): {
    cfg: OpenClawConfig;
    storePath: string;
};
export declare function readAcpSessionEntry(params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
}): AcpSessionStoreEntry | null;
export declare function listAcpSessionEntries(params: {
    cfg?: OpenClawConfig;
}): Promise<AcpSessionStoreEntry[]>;
export declare function upsertAcpSessionMeta(params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
    mutate: (current: SessionAcpMeta | undefined, entry: SessionEntry | undefined) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null>;
