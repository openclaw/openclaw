import { r as normalizeLegacyDmAliases } from "./dm-access-CP9QxWdj.js";
import "./uninstall-Cvtk5oOG.js";
//#region src/config/channel-compat-normalization.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function hasLegacyAccountStreamingAliases(value, match) {
	const accounts = asObjectRecord(value);
	if (!accounts) return false;
	return Object.values(accounts).some((account) => match(account));
}
function ensureNestedRecord(owner, key) {
	const existing = asObjectRecord(owner[key]);
	if (existing) return { ...existing };
	return {};
}
function normalizeLegacyStreamingAliases(params) {
	const beforeStreaming = params.entry.streaming;
	const hadLegacyStreamMode = params.entry.streamMode !== void 0;
	const hasLegacyFlatFields = params.entry.chunkMode !== void 0 || params.entry.blockStreaming !== void 0 || params.entry.blockStreamingCoalesce !== void 0 || params.includePreviewChunk === true && params.entry.draftChunk !== void 0 || params.entry.nativeStreaming !== void 0;
	if (!(hadLegacyStreamMode || typeof beforeStreaming === "boolean" || typeof beforeStreaming === "string" || hasLegacyFlatFields)) return {
		entry: params.entry,
		changed: false
	};
	let updated = { ...params.entry };
	let changed = false;
	const streaming = ensureNestedRecord(updated, "streaming");
	const block = ensureNestedRecord(streaming, "block");
	const preview = ensureNestedRecord(streaming, "preview");
	if ((hadLegacyStreamMode || typeof beforeStreaming === "boolean" || typeof beforeStreaming === "string") && streaming.mode === void 0) {
		streaming.mode = params.resolvedMode;
		if (hadLegacyStreamMode) params.changes.push(`Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`);
		else if (typeof beforeStreaming === "boolean") params.changes.push(`Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`);
		else if (typeof beforeStreaming === "string") params.changes.push(`Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`);
		changed = true;
	}
	if (hadLegacyStreamMode) {
		delete updated.streamMode;
		changed = true;
	}
	if (updated.chunkMode !== void 0 && streaming.chunkMode === void 0) {
		streaming.chunkMode = updated.chunkMode;
		delete updated.chunkMode;
		params.changes.push(`Moved ${params.pathPrefix}.chunkMode → ${params.pathPrefix}.streaming.chunkMode.`);
		changed = true;
	}
	if (updated.blockStreaming !== void 0 && block.enabled === void 0) {
		block.enabled = updated.blockStreaming;
		delete updated.blockStreaming;
		params.changes.push(`Moved ${params.pathPrefix}.blockStreaming → ${params.pathPrefix}.streaming.block.enabled.`);
		changed = true;
	}
	if (params.includePreviewChunk === true && updated.draftChunk !== void 0 && preview.chunk === void 0) {
		preview.chunk = updated.draftChunk;
		delete updated.draftChunk;
		params.changes.push(`Moved ${params.pathPrefix}.draftChunk → ${params.pathPrefix}.streaming.preview.chunk.`);
		changed = true;
	}
	if (updated.blockStreamingCoalesce !== void 0 && block.coalesce === void 0) {
		block.coalesce = updated.blockStreamingCoalesce;
		delete updated.blockStreamingCoalesce;
		params.changes.push(`Moved ${params.pathPrefix}.blockStreamingCoalesce → ${params.pathPrefix}.streaming.block.coalesce.`);
		changed = true;
	}
	if (updated.nativeStreaming !== void 0 && streaming.nativeTransport === void 0 && params.resolvedNativeTransport !== void 0) {
		streaming.nativeTransport = params.resolvedNativeTransport;
		delete updated.nativeStreaming;
		params.changes.push(`Moved ${params.pathPrefix}.nativeStreaming → ${params.pathPrefix}.streaming.nativeTransport.`);
		changed = true;
	} else if (typeof beforeStreaming === "boolean" && streaming.nativeTransport === void 0 && params.resolvedNativeTransport !== void 0) {
		streaming.nativeTransport = params.resolvedNativeTransport;
		params.changes.push(`Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.nativeTransport.`);
		changed = true;
	}
	if (Object.keys(preview).length > 0) streaming.preview = preview;
	if (Object.keys(block).length > 0) streaming.block = block;
	updated.streaming = streaming;
	if (hadLegacyStreamMode && params.resolvedMode === "off" && params.offModeLegacyNotice !== void 0) params.changes.push(params.offModeLegacyNotice(params.pathPrefix));
	return {
		entry: updated,
		changed
	};
}
function normalizeLegacyChannelAliases(params) {
	let updated = params.entry;
	let changed = false;
	if (params.normalizeDm === true) {
		const dm = normalizeLegacyDmAliases({
			entry: updated,
			pathPrefix: params.pathPrefix,
			changes: params.changes,
			promoteAllowFrom: params.rootDmPromoteAllowFrom
		});
		updated = dm.entry;
		changed = dm.changed;
	}
	const streaming = normalizeLegacyStreamingAliases({
		entry: updated,
		pathPrefix: params.pathPrefix,
		changes: params.changes,
		...params.resolveStreamingOptions(updated)
	});
	updated = streaming.entry;
	changed = changed || streaming.changed;
	const rawAccounts = asObjectRecord(updated.accounts);
	if (!rawAccounts) return {
		entry: updated,
		changed
	};
	let accountsChanged = false;
	const accounts = { ...rawAccounts };
	for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
		const account = asObjectRecord(rawAccount);
		if (!account) continue;
		let accountEntry = account;
		let accountChanged = false;
		const accountPathPrefix = `${params.pathPrefix}.accounts.${accountId}`;
		if (params.normalizeAccountDm === true) {
			const accountDm = normalizeLegacyDmAliases({
				entry: accountEntry,
				pathPrefix: accountPathPrefix,
				changes: params.changes
			});
			accountEntry = accountDm.entry;
			accountChanged = accountDm.changed;
		}
		const accountStreaming = normalizeLegacyStreamingAliases({
			entry: accountEntry,
			pathPrefix: accountPathPrefix,
			changes: params.changes,
			...params.resolveStreamingOptions(accountEntry)
		});
		accountEntry = accountStreaming.entry;
		accountChanged = accountChanged || accountStreaming.changed;
		const accountExtra = params.normalizeAccountExtra?.({
			account: accountEntry,
			accountId,
			pathPrefix: accountPathPrefix,
			changes: params.changes
		});
		if (accountExtra) {
			accountEntry = accountExtra.entry;
			accountChanged = accountChanged || accountExtra.changed;
		}
		if (accountChanged) {
			accounts[accountId] = accountEntry;
			accountsChanged = true;
		}
	}
	if (accountsChanged) {
		updated = {
			...updated,
			accounts
		};
		changed = true;
	}
	return {
		entry: updated,
		changed
	};
}
function hasLegacyStreamingAliases(value, options) {
	const entry = asObjectRecord(value);
	if (!entry) return false;
	return entry.streamMode !== void 0 || typeof entry.streaming === "boolean" || typeof entry.streaming === "string" || entry.chunkMode !== void 0 || entry.blockStreaming !== void 0 || entry.blockStreamingCoalesce !== void 0 || options?.includePreviewChunk === true && entry.draftChunk !== void 0 || options?.includeNativeTransport === true && entry.nativeStreaming !== void 0;
}
//#endregion
export { normalizeLegacyStreamingAliases as a, normalizeLegacyChannelAliases as i, hasLegacyAccountStreamingAliases as n, hasLegacyStreamingAliases as r, asObjectRecord as t };
