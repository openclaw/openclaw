import { requireAcpRuntimeBackend } from "../runtime/registry.js";
import { listAcpSessionEntries, readAcpSessionEntry, upsertAcpSessionMeta, } from "../runtime/session-meta.js";
export const DEFAULT_DEPS = {
    listAcpSessions: listAcpSessionEntries,
    readSessionEntry: readAcpSessionEntry,
    upsertSessionMeta: upsertAcpSessionMeta,
    requireRuntimeBackend: requireAcpRuntimeBackend,
};
