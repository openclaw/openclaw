import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
//#region src/sessions/model-overrides.ts
function clearFallbackOrigin(entry) {
	let updated = false;
	if (entry.modelOverrideFallbackOriginProvider !== void 0) {
		delete entry.modelOverrideFallbackOriginProvider;
		updated = true;
	}
	if (entry.modelOverrideFallbackOriginModel !== void 0) {
		delete entry.modelOverrideFallbackOriginModel;
		updated = true;
	}
	return updated;
}
function applyModelOverrideToSessionEntry(params) {
	const { entry, selection, profileOverride } = params;
	const profileOverrideSource = params.profileOverrideSource ?? "user";
	const selectionSource = params.selectionSource ?? "user";
	let updated = false;
	let selectionUpdated = false;
	if (selection.isDefault) {
		if (entry.providerOverride) {
			delete entry.providerOverride;
			updated = true;
			selectionUpdated = true;
		}
		if (entry.modelOverride) {
			delete entry.modelOverride;
			updated = true;
			selectionUpdated = true;
		}
		if (entry.modelOverrideSource) {
			delete entry.modelOverrideSource;
			updated = true;
		}
		updated = clearFallbackOrigin(entry) || updated;
	} else {
		if (entry.providerOverride !== selection.provider) {
			entry.providerOverride = selection.provider;
			updated = true;
			selectionUpdated = true;
		}
		if (entry.modelOverride !== selection.model) {
			entry.modelOverride = selection.model;
			updated = true;
			selectionUpdated = true;
		}
		if (entry.modelOverrideSource !== selectionSource) {
			entry.modelOverrideSource = selectionSource;
			updated = true;
		}
		updated = clearFallbackOrigin(entry) || updated;
	}
	const runtimeModel = normalizeOptionalString(entry.model) ?? "";
	const runtimeProvider = normalizeOptionalString(entry.modelProvider) ?? "";
	const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
	const runtimeAligned = runtimeModel === selection.model && (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
	if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
		if (entry.model !== void 0) {
			delete entry.model;
			updated = true;
		}
		if (entry.modelProvider !== void 0) {
			delete entry.modelProvider;
			updated = true;
		}
	}
	if (entry.contextTokens !== void 0 && (selectionUpdated || runtimePresent && !runtimeAligned)) {
		delete entry.contextTokens;
		updated = true;
	}
	if (profileOverride) {
		if (entry.authProfileOverride !== profileOverride) {
			entry.authProfileOverride = profileOverride;
			updated = true;
		}
		if (entry.authProfileOverrideSource !== profileOverrideSource) {
			entry.authProfileOverrideSource = profileOverrideSource;
			updated = true;
		}
		if (entry.authProfileOverrideCompactionCount !== void 0) {
			delete entry.authProfileOverrideCompactionCount;
			updated = true;
		}
	} else if (!params.preserveAuthProfileOverride) {
		if (entry.authProfileOverride) {
			delete entry.authProfileOverride;
			updated = true;
		}
		if (entry.authProfileOverrideSource) {
			delete entry.authProfileOverrideSource;
			updated = true;
		}
		if (entry.authProfileOverrideCompactionCount !== void 0) {
			delete entry.authProfileOverrideCompactionCount;
			updated = true;
		}
	}
	if (updated) {
		if (selectionUpdated && params.markLiveSwitchPending) entry.liveModelSwitchPending = true;
		delete entry.fallbackNoticeSelectedModel;
		delete entry.fallbackNoticeActiveModel;
		delete entry.fallbackNoticeReason;
		entry.updatedAt = Date.now();
	}
	return { updated };
}
function wrappedOverrideModel(provider, model) {
	return `${provider}/${model}`;
}
function repairProviderWrappedModelOverride(params) {
	const overrideProvider = normalizeOptionalString(params.entry.providerOverride);
	const overrideModel = normalizeOptionalString(params.entry.modelOverride);
	if (!overrideProvider || !overrideModel) return { updated: false };
	const wrappedModel = wrappedOverrideModel(overrideProvider, overrideModel);
	const runtimeProvider = normalizeOptionalString(params.entry.modelProvider);
	const runtimeModel = normalizeOptionalString(params.entry.model);
	if (runtimeProvider && runtimeModel === wrappedModel && runtimeProvider !== overrideProvider) return applyModelOverrideToSessionEntry({
		entry: params.entry,
		selection: {
			provider: runtimeProvider,
			model: runtimeModel,
			isDefault: runtimeProvider === params.defaultProvider && runtimeModel === params.defaultModel
		},
		selectionSource: params.entry.modelOverrideSource === "auto" ? "auto" : "user"
	});
	if (params.defaultProvider !== overrideProvider && params.defaultModel === wrappedModel) return applyModelOverrideToSessionEntry({
		entry: params.entry,
		selection: {
			provider: params.defaultProvider,
			model: params.defaultModel,
			isDefault: true
		}
	});
	return { updated: false };
}
//#endregion
export { repairProviderWrappedModelOverride as n, applyModelOverrideToSessionEntry as t };
