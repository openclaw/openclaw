import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization-PRIe4LWk.js";
import { i as NODE_SYSTEM_RUN_COMMANDS, r as NODE_SYSTEM_NOTIFY_COMMAND, t as NODE_BROWSER_PROXY_COMMAND } from "./node-commands-SnI8Vs7F.js";
import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
//#region src/gateway/node-command-policy.ts
const CAMERA_COMMANDS = ["camera.list"];
const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip"];
const SCREEN_COMMANDS = ["screen.snapshot"];
const SCREEN_DANGEROUS_COMMANDS = ["screen.record"];
const LOCATION_COMMANDS = ["location.get"];
const ANDROID_NOTIFICATION_COMMANDS = [...["notifications.list"], "notifications.actions"];
const DEVICE_COMMANDS = ["device.info", "device.status"];
const ANDROID_DEVICE_COMMANDS = [
	...DEVICE_COMMANDS,
	"device.permissions",
	"device.health"
];
const CONTACTS_COMMANDS = ["contacts.search"];
const CONTACTS_DANGEROUS_COMMANDS = ["contacts.add"];
const CALENDAR_COMMANDS = ["calendar.events"];
const CALENDAR_DANGEROUS_COMMANDS = ["calendar.add"];
const CALL_LOG_COMMANDS = ["callLog.search"];
const REMINDERS_COMMANDS = ["reminders.list"];
const REMINDERS_DANGEROUS_COMMANDS = ["reminders.add"];
const PHOTOS_COMMANDS = ["photos.latest"];
const MOTION_COMMANDS = ["motion.activity", "motion.pedometer"];
const SMS_DANGEROUS_COMMANDS = ["sms.send", "sms.search"];
const TALK_PTT_COMMANDS = [
	"talk.ptt.start",
	"talk.ptt.stop",
	"talk.ptt.cancel",
	"talk.ptt.once"
];
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];
const SYSTEM_COMMANDS = [
	...NODE_SYSTEM_RUN_COMMANDS,
	NODE_SYSTEM_NOTIFY_COMMAND,
	NODE_BROWSER_PROXY_COMMAND
];
const DESKTOP_HOST_COMMANDS = new Set([
	...NODE_SYSTEM_RUN_COMMANDS,
	NODE_BROWSER_PROXY_COMMAND,
	...SCREEN_COMMANDS
]);
const UNKNOWN_PLATFORM_COMMANDS = [
	...CAMERA_COMMANDS,
	...LOCATION_COMMANDS,
	NODE_SYSTEM_NOTIFY_COMMAND
];
const DEFAULT_DANGEROUS_NODE_COMMANDS = [
	...CAMERA_DANGEROUS_COMMANDS,
	...SCREEN_DANGEROUS_COMMANDS,
	...CONTACTS_DANGEROUS_COMMANDS,
	...CALENDAR_DANGEROUS_COMMANDS,
	...REMINDERS_DANGEROUS_COMMANDS,
	...SMS_DANGEROUS_COMMANDS
];
const PLATFORM_DEFAULTS = {
	ios: [
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...DEVICE_COMMANDS,
		...CONTACTS_COMMANDS,
		...CALENDAR_COMMANDS,
		...REMINDERS_COMMANDS,
		...PHOTOS_COMMANDS,
		...MOTION_COMMANDS,
		...IOS_SYSTEM_COMMANDS
	],
	android: [
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...ANDROID_NOTIFICATION_COMMANDS,
		NODE_SYSTEM_NOTIFY_COMMAND,
		...ANDROID_DEVICE_COMMANDS,
		...CONTACTS_COMMANDS,
		...CALENDAR_COMMANDS,
		...CALL_LOG_COMMANDS,
		...REMINDERS_COMMANDS,
		...PHOTOS_COMMANDS,
		...MOTION_COMMANDS
	],
	macos: [
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...DEVICE_COMMANDS,
		...CONTACTS_COMMANDS,
		...CALENDAR_COMMANDS,
		...REMINDERS_COMMANDS,
		...PHOTOS_COMMANDS,
		...MOTION_COMMANDS,
		...SYSTEM_COMMANDS,
		...SCREEN_COMMANDS
	],
	linux: [...SYSTEM_COMMANDS],
	windows: [
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...DEVICE_COMMANDS,
		...SYSTEM_COMMANDS,
		...SCREEN_COMMANDS
	],
	unknown: [...UNKNOWN_PLATFORM_COMMANDS]
};
const CANONICAL_PLATFORM_IDS = new Set([
	"ios",
	"android",
	"macos",
	"windows",
	"linux"
]);
const DEVICE_FAMILY_TOKEN_RULES = [
	{
		id: "ios",
		tokens: [
			"iphone",
			"ipad",
			"ios"
		]
	},
	{
		id: "android",
		tokens: ["android"]
	},
	{
		id: "macos",
		tokens: ["mac"]
	},
	{
		id: "windows",
		tokens: ["windows"]
	},
	{
		id: "linux",
		tokens: ["linux"]
	}
];
function resolvePlatformIdByExactMatch(value) {
	if (CANONICAL_PLATFORM_IDS.has(value)) return value;
}
function platformMatchesDeviceFamily(platformId, family) {
	switch (platformId) {
		case "ios": return family === "" || /^(?:iphone|ipad|ios)$/.test(family);
		case "android": return family === "" || family === "android";
		case "macos": return family === "mac";
		case "windows": return family === "windows";
		case "linux": return family === "linux";
	}
	return false;
}
function resolvePlatformIdByNativeLabel(platform, deviceFamily) {
	if (/^(?:ios|ipados) \d+(?:\.\d+){0,2}$/.test(platform)) return /^(?:iphone|ipad|ios)$/.test(deviceFamily) ? "ios" : void 0;
	if (/^macos \d+(?:\.\d+){0,2}$/.test(platform)) return deviceFamily === "mac" ? "macos" : void 0;
	if (/^android \d+(?: \(sdk \d+\))?$/.test(platform)) return deviceFamily === "android" ? "android" : void 0;
}
function resolvePlatformIdByDeviceFamily(value) {
	for (const rule of DEVICE_FAMILY_TOKEN_RULES) if (rule.tokens.some((token) => value.includes(token))) return rule.id;
}
function normalizePlatformId(platform, deviceFamily) {
	const raw = normalizeDeviceMetadataForPolicy(platform);
	const family = normalizeDeviceMetadataForPolicy(deviceFamily);
	const byPlatform = resolvePlatformIdByExactMatch(raw);
	if (byPlatform) return platformMatchesDeviceFamily(byPlatform, family) ? byPlatform : "unknown";
	const byNativeLabel = resolvePlatformIdByNativeLabel(raw, family);
	if (byNativeLabel) return byNativeLabel;
	if (raw) return "unknown";
	return resolvePlatformIdByDeviceFamily(family) ?? "unknown";
}
function listDangerousPluginNodeCommands() {
	const registry = getActiveRuntimePluginRegistry();
	if (!registry) return [];
	const commands = [...(registry.nodeHostCommands ?? []).filter((entry) => entry.command.dangerous === true).map((entry) => entry.command.command), ...(registry.nodeInvokePolicies ?? []).filter((entry) => entry.policy.dangerous === true).flatMap((entry) => entry.policy.commands)];
	return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}
function listDefaultPluginNodeCommands(platformId) {
	const registry = getActiveRuntimePluginRegistry();
	if (!registry) return [];
	const commands = (registry.nodeInvokePolicies ?? []).flatMap((entry) => {
		if (entry.policy.dangerous === true) return [];
		return (entry.policy.defaultPlatforms ?? []).includes(platformId) ? entry.policy.commands : [];
	});
	return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}
function isForegroundRestrictedPluginNodeCommand(command) {
	const registry = getActiveRuntimePluginRegistry();
	if (!registry) return false;
	const normalized = command.trim();
	if (!normalized) return false;
	return (registry.nodeInvokePolicies ?? []).some((entry) => entry.policy.foregroundRestrictedOnIos === true && entry.policy.commands.some((policyCommand) => policyCommand.trim() === normalized));
}
function isDesktopPlatformId(platformId) {
	return platformId === "macos" || platformId === "windows" || platformId === "linux";
}
function filterDesktopHostCommandDefaults(params) {
	if (params.includeDesktopHostCommands === true || !isDesktopPlatformId(params.platformId)) return [...params.commands];
	return params.commands.filter((command) => !DESKTOP_HOST_COMMANDS.has(command));
}
function filterApprovedRuntimeCommands(params) {
	if (!isDesktopPlatformId(params.platformId)) return [];
	return params.commands.filter((command) => DESKTOP_HOST_COMMANDS.has(command.trim()));
}
function isLiveNodeSession(node) {
	return typeof node?.nodeId === "string" && node.nodeId.trim() !== "" && typeof node.connId === "string" && node.connId.trim() !== "";
}
function hasTalkSurface(node) {
	if (!node) return false;
	return (node.caps ?? []).some((capability) => normalizeOptionalLowercaseString(capability) === "talk") || (node.commands ?? []).some((command) => normalizeOptionalLowercaseString(command)?.startsWith("talk."));
}
function resolveNodeCommandAllowlistInternal(cfg, node, options) {
	const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
	const base = filterDesktopHostCommandDefaults({
		platformId,
		commands: PLATFORM_DEFAULTS[platformId] ?? PLATFORM_DEFAULTS.unknown,
		includeDesktopHostCommands: options?.includeDesktopHostCommands
	});
	const talkCommands = hasTalkSurface(node) ? TALK_PTT_COMMANDS : [];
	const pluginDefaults = listDefaultPluginNodeCommands(platformId);
	const approved = filterApprovedRuntimeCommands({
		platformId,
		commands: node?.approvedCommands ?? (isLiveNodeSession(node) ? node?.commands ?? [] : [])
	});
	const extra = cfg.gateway?.nodes?.allowCommands ?? [];
	const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
	const dangerousPluginCommands = new Set(listDangerousPluginNodeCommands());
	const allow = new Set([
		...base,
		...talkCommands,
		...pluginDefaults,
		...approved,
		...extra
	].map((cmd) => cmd.trim()).filter((cmd) => cmd && !dangerousPluginCommands.has(cmd)));
	for (const cmd of extra) {
		const trimmed = cmd.trim();
		if (trimmed) allow.add(trimmed);
	}
	for (const blocked of deny) {
		const trimmed = blocked.trim();
		if (trimmed) allow.delete(trimmed);
	}
	return allow;
}
function resolveNodeCommandAllowlist(cfg, node) {
	return resolveNodeCommandAllowlistInternal(cfg, node);
}
function resolveNodePairingCommandAllowlist(cfg, node) {
	return resolveNodeCommandAllowlistInternal(cfg, node, { includeDesktopHostCommands: true });
}
function normalizeDeclaredCommands(commands) {
	if (!Array.isArray(commands)) return [];
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const value of commands) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}
function normalizeDeclaredNodeCommands(params) {
	return normalizeDeclaredCommands(params.declaredCommands).filter((command) => params.allowlist.has(command));
}
function isNodeCommandAllowed(params) {
	const command = params.command.trim();
	if (!command) return {
		ok: false,
		reason: "command required"
	};
	if (!params.allowlist.has(command)) return {
		ok: false,
		reason: "command not allowlisted"
	};
	if (Array.isArray(params.declaredCommands) && params.declaredCommands.length > 0) {
		if (!params.declaredCommands.includes(command)) return {
			ok: false,
			reason: "command not declared by node"
		};
	} else return {
		ok: false,
		reason: "node did not declare commands"
	};
	return { ok: true };
}
//#endregion
export { normalizeDeclaredNodeCommands as a, listDangerousPluginNodeCommands as i, isForegroundRestrictedPluginNodeCommand as n, resolveNodeCommandAllowlist as o, isNodeCommandAllowed as r, resolveNodePairingCommandAllowlist as s, DEFAULT_DANGEROUS_NODE_COMMANDS as t };
