import path from "node:path";
import { resolveAgentSessionDirs } from "../../agents/session-dirs.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { mergeSessionEntry, } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
function resolveStoreSessionKey(store, sessionKey) {
    const normalized = sessionKey.trim();
    if (!normalized) {
        return "";
    }
    if (store[normalized]) {
        return normalized;
    }
    const lower = normalized.toLowerCase();
    if (store[lower]) {
        return lower;
    }
    for (const key of Object.keys(store)) {
        if (key.toLowerCase() === lower) {
            return key;
        }
    }
    return lower;
}
export function resolveSessionStorePathForAcp(params) {
    const cfg = params.cfg ?? loadConfig();
    const parsed = parseAgentSessionKey(params.sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, {
        agentId: parsed?.agentId,
    });
    return { cfg, storePath };
}
export function readAcpSessionEntry(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
        return null;
    }
    const { cfg, storePath } = resolveSessionStorePathForAcp({
        sessionKey,
        cfg: params.cfg,
    });
    let store;
    let storeReadFailed = false;
    try {
        store = loadSessionStore(storePath);
    }
    catch {
        storeReadFailed = true;
        store = {};
    }
    const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
    const entry = store[storeSessionKey];
    return {
        cfg,
        storePath,
        sessionKey,
        storeSessionKey,
        entry,
        acp: entry?.acp,
        storeReadFailed,
    };
}
export async function listAcpSessionEntries(params) {
    const cfg = params.cfg ?? loadConfig();
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    const entries = [];
    for (const sessionsDir of sessionDirs) {
        const storePath = path.join(sessionsDir, "sessions.json");
        let store;
        try {
            store = loadSessionStore(storePath);
        }
        catch {
            continue;
        }
        for (const [sessionKey, entry] of Object.entries(store)) {
            if (!entry?.acp) {
                continue;
            }
            entries.push({
                cfg,
                storePath,
                sessionKey,
                storeSessionKey: sessionKey,
                entry,
                acp: entry.acp,
            });
        }
    }
    return entries;
}
export async function upsertAcpSessionMeta(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
        return null;
    }
    const { storePath } = resolveSessionStorePathForAcp({
        sessionKey,
        cfg: params.cfg,
    });
    return await updateSessionStore(storePath, (store) => {
        const storeSessionKey = resolveStoreSessionKey(store, sessionKey);
        const currentEntry = store[storeSessionKey];
        const nextMeta = params.mutate(currentEntry?.acp, currentEntry);
        if (nextMeta === undefined) {
            return currentEntry ?? null;
        }
        if (nextMeta === null && !currentEntry) {
            return null;
        }
        const nextEntry = mergeSessionEntry(currentEntry, {
            acp: nextMeta ?? undefined,
        });
        if (nextMeta === null) {
            delete nextEntry.acp;
        }
        store[storeSessionKey] = nextEntry;
        return nextEntry;
    }, {
        activeSessionKey: sessionKey.toLowerCase(),
    });
}
