import { i as normalizeLegacyChannelAliases, n as hasLegacyAccountStreamingAliases, r as hasLegacyStreamingAliases, t as asObjectRecord } from "./runtime-doctor-p5TvjiM-.js";
import { t as resolveTelegramPreviewStreamMode } from "./preview-streaming-CpiesNih.js";
//#region extensions/telegram/src/doctor-contract.ts
function hasLegacyTelegramStreamingAliases(value) {
	return hasLegacyStreamingAliases(value, { includePreviewChunk: true });
}
function resolveCompatibleDefaultGroupEntry(section) {
	const existingGroups = section.groups;
	if (existingGroups !== void 0 && !asObjectRecord(existingGroups)) return null;
	const groups = asObjectRecord(existingGroups) ?? {};
	const existingEntry = groups["*"];
	if (existingEntry !== void 0 && !asObjectRecord(existingEntry)) return null;
	return {
		groups,
		entry: asObjectRecord(existingEntry) ?? {}
	};
}
const legacyConfigRules = [
	{
		path: [
			"channels",
			"telegram",
			"groupMentionsOnly"
		],
		message: "channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups.\"*\".requireMention instead. Run \"openclaw doctor --fix\"."
	},
	{
		path: ["channels", "telegram"],
		message: "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
		match: hasLegacyTelegramStreamingAliases
	},
	{
		path: [
			"channels",
			"telegram",
			"accounts"
		],
		message: "channels.telegram.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
		match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyTelegramStreamingAliases)
	}
];
function normalizeCompatibilityConfig({ cfg }) {
	const rawEntry = asObjectRecord(cfg.channels?.telegram);
	if (!rawEntry) return {
		config: cfg,
		changes: []
	};
	const changes = [];
	let updated = rawEntry;
	let changed = false;
	if (updated.groupMentionsOnly !== void 0) {
		const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(updated);
		if (!defaultGroupEntry) changes.push("Skipped channels.telegram.groupMentionsOnly migration because channels.telegram.groups already has an incompatible shape; fix remaining issues manually.");
		else {
			const { groups, entry } = defaultGroupEntry;
			if (entry.requireMention === void 0) {
				entry.requireMention = updated.groupMentionsOnly;
				groups["*"] = entry;
				updated = {
					...updated,
					groups
				};
				changes.push("Moved channels.telegram.groupMentionsOnly → channels.telegram.groups.\"*\".requireMention.");
			} else changes.push("Removed channels.telegram.groupMentionsOnly (channels.telegram.groups.\"*\" already set).");
			const { groupMentionsOnly: _ignored, ...rest } = updated;
			updated = rest;
			changed = true;
		}
	}
	const aliases = normalizeLegacyChannelAliases({
		entry: updated,
		pathPrefix: "channels.telegram",
		changes,
		resolveStreamingOptions: (entry) => ({
			includePreviewChunk: true,
			resolvedMode: resolveTelegramPreviewStreamMode(entry)
		})
	});
	updated = aliases.entry;
	changed = changed || aliases.changed;
	if (!changed && changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: {
			...cfg,
			channels: {
				...cfg.channels,
				telegram: updated
			}
		},
		changes
	};
}
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
