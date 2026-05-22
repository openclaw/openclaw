import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as note } from "./note-Dg2Luaaq.js";
//#region src/commands/doctor-command-owner.ts
function resolveConfiguredCommandOwners(cfg) {
	const owners = cfg.commands?.ownerAllowFrom;
	if (!Array.isArray(owners)) return [];
	return owners.map((entry) => normalizeOptionalString(String(entry ?? "")) ?? "").filter(Boolean);
}
function hasConfiguredCommandOwners(cfg) {
	return resolveConfiguredCommandOwners(cfg).length > 0;
}
function formatCommandOwnerFromChannelSender(params) {
	const id = normalizeOptionalString(params.id);
	if (!id) return null;
	const separatorIndex = id.indexOf(":");
	if (separatorIndex > 0) {
		if (id.slice(0, separatorIndex).toLowerCase() === String(params.channel).toLowerCase()) return id;
	}
	return `${params.channel}:${id}`;
}
function noteCommandOwnerHealth(cfg) {
	if (hasConfiguredCommandOwners(cfg)) return;
	note([
		"No command owner is configured.",
		"A command owner is the human operator account allowed to run owner-only commands and approve dangerous actions, including /diagnostics, /export-trajectory, /config, and exec approvals.",
		"DM pairing only lets someone talk to the bot; it does not make that sender the owner for privileged commands.",
		`Fix: set commands.ownerAllowFrom to your channel user id, for example ${formatCliCommand("openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'")}`,
		"Restart the gateway after changing this if it is already running."
	].join("\n"), "Command owner");
}
//#endregion
export { hasConfiguredCommandOwners as n, noteCommandOwnerHealth as r, formatCommandOwnerFromChannelSender as t };
