import "./account-id-Bj7l9NI7.js";
//#region src/channels/plugins/config-helpers.ts
function isConfiguredSecretValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	return Boolean(value);
}
function setAccountEnabledInConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	const hasAccounts = Boolean(base?.accounts);
	if (params.allowTopLevel && accountKey === "default" && !hasAccounts) return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				enabled: params.enabled
			}
		}
	};
	const baseAccounts = base?.accounts ?? {};
	const existing = baseAccounts[accountKey] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.sectionKey]: {
				...base,
				accounts: {
					...baseAccounts,
					[accountKey]: {
						...existing,
						enabled: params.enabled
					}
				}
			}
		}
	};
}
function deleteAccountFromConfigSection(params) {
	const accountKey = params.accountId || "default";
	const base = params.cfg.channels?.[params.sectionKey];
	if (!base) return params.cfg;
	const baseAccounts = base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : void 0;
	if (accountKey !== "default") {
		const accounts = baseAccounts ? { ...baseAccounts } : {};
		delete accounts[accountKey];
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...base,
					accounts: Object.keys(accounts).length ? accounts : void 0
				}
			}
		};
	}
	if (baseAccounts && Object.keys(baseAccounts).length > 0) {
		delete baseAccounts[accountKey];
		const baseRecord = { ...base };
		for (const field of params.clearBaseFields ?? []) if (field in baseRecord) baseRecord[field] = void 0;
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.sectionKey]: {
					...baseRecord,
					accounts: Object.keys(baseAccounts).length ? baseAccounts : void 0
				}
			}
		};
	}
	const nextChannels = { ...params.cfg.channels };
	delete nextChannels[params.sectionKey];
	const nextCfg = { ...params.cfg };
	if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
	else delete nextCfg.channels;
	return nextCfg;
}
function clearAccountEntryFields(params) {
	const accountKey = params.accountId || "default";
	const baseAccounts = params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : void 0;
	if (!baseAccounts || !(accountKey in baseAccounts)) return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const entry = baseAccounts[accountKey];
	if (!entry || typeof entry !== "object") return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const nextEntry = { ...entry };
	if (!params.fields.some((field) => field in nextEntry)) return {
		nextAccounts: baseAccounts,
		changed: false,
		cleared: false
	};
	const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
	let cleared = Boolean(params.markClearedOnFieldPresence);
	for (const field of params.fields) {
		if (!(field in nextEntry)) continue;
		if (isValueSet(nextEntry[field])) cleared = true;
		delete nextEntry[field];
	}
	if (Object.keys(nextEntry).length === 0) delete baseAccounts[accountKey];
	else baseAccounts[accountKey] = nextEntry;
	return {
		nextAccounts: Object.keys(baseAccounts).length > 0 ? baseAccounts : void 0,
		changed: true,
		cleared
	};
}
//#endregion
export { deleteAccountFromConfigSection as n, setAccountEnabledInConfigSection as r, clearAccountEntryFields as t };
