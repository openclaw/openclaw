import { i as resolveSessionFilePath } from "./paths-CEC5JHmb.js";
import { o as updateSessionStore, p as resolveSessionStoreEntry } from "./store-DypV6NYF.js";
//#region src/config/sessions/session-file.ts
async function resolveAndPersistSessionFile(params) {
	const { sessionId, sessionKey, sessionStore, storePath } = params;
	const now = Date.now();
	const memResolved = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey
	});
	const baseEntry = params.sessionEntry ?? memResolved.existing ?? {
		sessionId,
		updatedAt: now,
		sessionStartedAt: now
	};
	const shouldReusePersistedSessionFile = baseEntry.sessionId === sessionId;
	const fallbackSessionFile = params.fallbackSessionFile?.trim();
	const sessionFile = resolveSessionFilePath(sessionId, !shouldReusePersistedSessionFile ? fallbackSessionFile ? {
		...baseEntry,
		sessionFile: fallbackSessionFile
	} : {
		...baseEntry,
		sessionFile: void 0
	} : !baseEntry.sessionFile && fallbackSessionFile ? {
		...baseEntry,
		sessionFile: fallbackSessionFile
	} : baseEntry, {
		agentId: params.agentId,
		sessionsDir: params.sessionsDir
	});
	const persistedEntry = {
		...baseEntry,
		sessionId,
		updatedAt: now,
		sessionStartedAt: baseEntry.sessionId === sessionId ? baseEntry.sessionStartedAt ?? now : now,
		sessionFile
	};
	if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
		sessionStore[memResolved.normalizedKey] = persistedEntry;
		for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
		await updateSessionStore(storePath, (store) => {
			const resolved = resolveSessionStoreEntry({
				store,
				sessionKey
			});
			store[resolved.normalizedKey] = {
				...resolved.existing,
				...persistedEntry
			};
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}, params.activeSessionKey || params.maintenanceConfig ? {
			...params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : {},
			...params.maintenanceConfig ? { maintenanceConfig: params.maintenanceConfig } : {}
		} : void 0);
		return {
			sessionFile,
			sessionEntry: persistedEntry
		};
	}
	sessionStore[memResolved.normalizedKey] = persistedEntry;
	for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
	return {
		sessionFile,
		sessionEntry: persistedEntry
	};
}
//#endregion
export { resolveAndPersistSessionFile as t };
