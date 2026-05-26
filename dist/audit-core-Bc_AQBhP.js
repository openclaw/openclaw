import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { It as ChannelType } from "./discord-Cn5UmvYW.js";
//#region extensions/discord/src/audit-core.ts
const REQUIRED_TEXT_CHANNEL_PERMISSIONS = ["ViewChannel", "SendMessages"];
const REQUIRED_VOICE_CHANNEL_PERMISSIONS = [
	"ViewChannel",
	"Connect",
	"Speak",
	"SendMessages",
	"ReadMessageHistory"
];
function resolveRequiredDiscordChannelPermissions(channelType) {
	if (channelType === ChannelType.GuildVoice || channelType === ChannelType.GuildStageVoice) return [...REQUIRED_VOICE_CHANNEL_PERMISSIONS];
	return [...REQUIRED_TEXT_CHANNEL_PERMISSIONS];
}
function shouldAuditChannelConfig(config) {
	if (!config) return true;
	if (config.enabled === false) return false;
	return true;
}
function listConfiguredGuildChannelKeys(guilds) {
	if (!guilds) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const entry of Object.values(guilds)) {
		if (!entry || typeof entry !== "object") continue;
		const channelsRaw = entry.channels;
		if (!isRecord(channelsRaw)) continue;
		for (const [key, value] of Object.entries(channelsRaw)) {
			const channelId = normalizeOptionalString(key) ?? "";
			if (!channelId) continue;
			if (channelId === "*") continue;
			if (!shouldAuditChannelConfig(value)) continue;
			ids.add(channelId);
		}
	}
	return [...ids].toSorted((a, b) => a.localeCompare(b));
}
function collectDiscordAuditChannelIdsForGuilds(guilds) {
	const keys = listConfiguredGuildChannelKeys(guilds);
	const channelIds = keys.filter((key) => /^\d+$/.test(key));
	return {
		channelIds,
		unresolvedChannels: keys.length - channelIds.length
	};
}
function collectDiscordAuditChannelIdsForAccount(config) {
	const collected = collectDiscordAuditChannelIdsForGuilds(config.guilds);
	const channelIds = new Set(collected.channelIds);
	let unresolvedVoiceChannels = 0;
	for (const entry of config.voice?.autoJoin ?? []) {
		const channelId = normalizeOptionalString(entry?.channelId) ?? "";
		if (/^\d+$/.test(channelId)) channelIds.add(channelId);
		else if (channelId) unresolvedVoiceChannels++;
	}
	return {
		channelIds: [...channelIds].toSorted((a, b) => a.localeCompare(b)),
		unresolvedChannels: collected.unresolvedChannels + unresolvedVoiceChannels
	};
}
async function auditDiscordChannelPermissionsWithFetcher(params) {
	const started = Date.now();
	const token = normalizeOptionalString(params.token) ?? "";
	if (!token || params.channelIds.length === 0) return {
		ok: true,
		checkedChannels: 0,
		unresolvedChannels: 0,
		channels: [],
		elapsedMs: Date.now() - started
	};
	const channels = [];
	for (const channelId of params.channelIds) try {
		const perms = await params.fetchChannelPermissions(channelId, {
			cfg: params.cfg,
			token,
			accountId: params.accountId ?? void 0
		});
		const missing = resolveRequiredDiscordChannelPermissions(perms.channelType).filter((p) => !perms.permissions.includes(p));
		channels.push({
			channelId,
			ok: missing.length === 0,
			missing: missing.length ? missing : void 0,
			error: null,
			matchKey: channelId,
			matchSource: "id"
		});
	} catch (err) {
		channels.push({
			channelId,
			ok: false,
			error: formatErrorMessage(err),
			matchKey: channelId,
			matchSource: "id"
		});
	}
	return {
		ok: channels.every((c) => c.ok),
		checkedChannels: channels.length,
		unresolvedChannels: 0,
		channels,
		elapsedMs: Date.now() - started
	};
}
//#endregion
export { collectDiscordAuditChannelIdsForAccount as n, resolveRequiredDiscordChannelPermissions as r, auditDiscordChannelPermissionsWithFetcher as t };
