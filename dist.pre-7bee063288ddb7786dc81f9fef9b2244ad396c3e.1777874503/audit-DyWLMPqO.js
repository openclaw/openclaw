import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import "./text-runtime-icMZVCaq.js";
import "./error-runtime-B9i9dR6-.js";
import { t as inspectDiscordAccount } from "./account-inspect-brdlCm9t.js";
import { T as fetchChannelPermissionsDiscord } from "./send.shared-BgtjIk0s.js";
import "./send-pG2sCBOD.js";
//#region extensions/discord/src/audit-core.ts
const REQUIRED_CHANNEL_PERMISSIONS = ["ViewChannel", "SendMessages"];
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
	const required = [...REQUIRED_CHANNEL_PERMISSIONS];
	const channels = [];
	for (const channelId of params.channelIds) try {
		const perms = await params.fetchChannelPermissions(channelId, {
			cfg: params.cfg,
			token,
			accountId: params.accountId ?? void 0
		});
		const missing = required.filter((p) => !perms.permissions.includes(p));
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
//#region extensions/discord/src/audit.ts
function collectDiscordAuditChannelIds(params) {
	return collectDiscordAuditChannelIdsForGuilds(inspectDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.guilds);
}
async function auditDiscordChannelPermissions(params) {
	return await auditDiscordChannelPermissionsWithFetcher({
		...params,
		fetchChannelPermissions: fetchChannelPermissionsDiscord
	});
}
//#endregion
export { collectDiscordAuditChannelIds as n, auditDiscordChannelPermissions as t };
