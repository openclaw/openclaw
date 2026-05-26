import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as resolveSessionParentSessionKey } from "./session-conversation-kSBVRbLR.js";
import { n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-B4tdZ1L4.js";
import { l as resolvePersistedOverrideModelRef } from "./model-selection-VRXWv5rs.js";
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
function resolveModelRefKey(params) {
	const ref = resolvePersistedOverrideModelRef(params);
	if (!ref) return null;
	const normalized = normalizeModelRef(ref.provider, ref.model);
	return modelKey(normalized.provider, normalized.model);
}
function isStaleHeartbeatAutoFallbackOverride(params) {
	if (params.isHeartbeat !== true || params.hasResolvedHeartbeatModelOverride === true) return false;
	if (params.storedOverride?.source !== "session") return false;
	if (params.sessionEntry?.modelOverrideSource !== "auto") return false;
	const primaryKey = resolveModelRefKey({
		defaultProvider: params.defaultProvider,
		overrideProvider: params.primaryProvider ?? params.defaultProvider,
		overrideModel: params.primaryModel ?? params.defaultModel
	});
	if (!primaryKey) return false;
	const originKey = resolveModelRefKey({
		defaultProvider: params.defaultProvider,
		overrideProvider: params.sessionEntry.modelOverrideFallbackOriginProvider,
		overrideModel: params.sessionEntry.modelOverrideFallbackOriginModel
	});
	if (originKey) return originKey !== primaryKey;
	const noticeSelectedKey = resolveModelRefKey({
		defaultProvider: params.defaultProvider,
		overrideModel: normalizeOptionalString(params.sessionEntry.fallbackNoticeSelectedModel)
	});
	if (noticeSelectedKey) return noticeSelectedKey !== primaryKey;
	const storedOverrideKey = resolveModelRefKey({
		defaultProvider: params.defaultProvider,
		overrideProvider: params.storedOverride.provider,
		overrideModel: params.storedOverride.model
	});
	return storedOverrideKey !== null && storedOverrideKey !== primaryKey;
}
//#endregion
export { resolveStoredModelOverride as n, isStaleHeartbeatAutoFallbackOverride as t };
