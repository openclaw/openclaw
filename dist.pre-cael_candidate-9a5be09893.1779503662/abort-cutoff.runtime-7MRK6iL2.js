import { F as resolveSessionStoreEntry } from "./store-load-DM26fo1a.js";
import { u as updateSessionStore } from "./store-CuGD5gZu.js";
import { n as hasAbortCutoff, t as applyAbortCutoffToSessionEntry } from "./abort-cutoff-cRHrB_Kx.js";
//#region src/auto-reply/reply/abort-cutoff.runtime.ts
async function clearAbortCutoffInSessionRuntime(params) {
	const { sessionEntry, sessionStore, sessionKey, storePath } = params;
	if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) return false;
	applyAbortCutoffToSessionEntry(sessionEntry, void 0);
	sessionEntry.updatedAt = Date.now();
	{
		const memResolved = resolveSessionStoreEntry({
			store: sessionStore,
			sessionKey
		});
		sessionStore[memResolved.normalizedKey] = sessionEntry;
		for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
	}
	if (storePath) await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const existing = resolved.existing ?? sessionEntry;
		if (!existing) return;
		applyAbortCutoffToSessionEntry(existing, void 0);
		existing.updatedAt = Date.now();
		store[resolved.normalizedKey] = existing;
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
	});
	return true;
}
//#endregion
export { clearAbortCutoffInSessionRuntime };
