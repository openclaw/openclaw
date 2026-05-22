import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as resolveSessionParentSessionKey } from "./session-conversation-CD_AQv7i.js";
import { l as resolvePersistedOverrideModelRef } from "./model-selection-DDEg6aT2.js";
//#region src/auto-reply/reply/stored-model-override.ts
function resolveParentSessionKeyCandidate(params) {
	const explicit = normalizeOptionalString(params.parentSessionKey);
	if (explicit && explicit !== params.sessionKey) return explicit;
	const derived = resolveSessionParentSessionKey(params.sessionKey);
	if (derived && derived !== params.sessionKey) return derived;
	return null;
}
function resolveStoredModelOverride(params) {
	const direct = resolvePersistedOverrideModelRef({
		defaultProvider: params.defaultProvider,
		overrideProvider: params.sessionEntry?.providerOverride,
		overrideModel: params.sessionEntry?.modelOverride
	});
	if (direct) return {
		...direct,
		source: "session"
	};
	const parentKey = resolveParentSessionKeyCandidate({
		sessionKey: params.sessionKey,
		parentSessionKey: params.parentSessionKey
	});
	if (!parentKey || !params.sessionStore) return null;
	const parentEntry = params.sessionStore[parentKey];
	const parentOverride = resolvePersistedOverrideModelRef({
		defaultProvider: params.defaultProvider,
		overrideProvider: parentEntry?.providerOverride,
		overrideModel: parentEntry?.modelOverride
	});
	if (!parentOverride) return null;
	return {
		...parentOverride,
		source: "parent"
	};
}
//#endregion
export { resolveStoredModelOverride as t };
