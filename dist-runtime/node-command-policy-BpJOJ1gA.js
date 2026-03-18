import { n as normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization-a2oQYp64.js";
import { i as NODE_SYSTEM_RUN_COMMANDS, r as NODE_SYSTEM_NOTIFY_COMMAND, t as NODE_BROWSER_PROXY_COMMAND } from "./node-commands-EFipWhU2.js";
//#region src/gateway/node-command-policy.ts
const CANVAS_COMMANDS = [
	"canvas.present",
	"canvas.hide",
	"canvas.navigate",
	"canvas.eval",
	"canvas.snapshot",
	"canvas.a2ui.push",
	"canvas.a2ui.pushJSONL",
	"canvas.a2ui.reset"
];
const CAMERA_COMMANDS = ["camera.list"];
const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip"];
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
const SMS_DANGEROUS_COMMANDS = ["sms.send"];
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];
const SYSTEM_COMMANDS = [
	...NODE_SYSTEM_RUN_COMMANDS,
	NODE_SYSTEM_NOTIFY_COMMAND,
	NODE_BROWSER_PROXY_COMMAND
];
const UNKNOWN_PLATFORM_COMMANDS = [
	...CANVAS_COMMANDS,
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
		...CANVAS_COMMANDS,
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
		...CANVAS_COMMANDS,
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
		...CANVAS_COMMANDS,
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...DEVICE_COMMANDS,
		...CONTACTS_COMMANDS,
		...CALENDAR_COMMANDS,
		...REMINDERS_COMMANDS,
		...PHOTOS_COMMANDS,
		...MOTION_COMMANDS,
		...SYSTEM_COMMANDS
	],
	linux: [...SYSTEM_COMMANDS],
	windows: [...SYSTEM_COMMANDS],
	unknown: [...UNKNOWN_PLATFORM_COMMANDS]
};
const PLATFORM_PREFIX_RULES = [
	{
		id: "ios",
		prefixes: ["ios"]
	},
	{
		id: "android",
		prefixes: ["android"]
	},
	{
		id: "macos",
		prefixes: ["mac", "darwin"]
	},
	{
		id: "windows",
		prefixes: ["win"]
	},
	{
		id: "linux",
		prefixes: ["linux"]
	}
];
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
function resolvePlatformIdByPrefix(value) {
	for (const rule of PLATFORM_PREFIX_RULES) if (rule.prefixes.some((prefix) => value.startsWith(prefix))) return rule.id;
}
function resolvePlatformIdByDeviceFamily(value) {
	for (const rule of DEVICE_FAMILY_TOKEN_RULES) if (rule.tokens.some((token) => value.includes(token))) return rule.id;
}
function normalizePlatformId(platform, deviceFamily) {
	const byPlatform = resolvePlatformIdByPrefix(normalizeDeviceMetadataForPolicy(platform));
	if (byPlatform) return byPlatform;
	return resolvePlatformIdByDeviceFamily(normalizeDeviceMetadataForPolicy(deviceFamily)) ?? "unknown";
}
function resolveNodeCommandAllowlist(cfg, node) {
	const base = PLATFORM_DEFAULTS[normalizePlatformId(node?.platform, node?.deviceFamily)] ?? PLATFORM_DEFAULTS.unknown;
	const extra = cfg.gateway?.nodes?.allowCommands ?? [];
	const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
	const allow = new Set([...base, ...extra].map((cmd) => cmd.trim()).filter(Boolean));
	for (const blocked of deny) {
		const trimmed = blocked.trim();
		if (trimmed) allow.delete(trimmed);
	}
	return allow;
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
export { isNodeCommandAllowed as n, resolveNodeCommandAllowlist as r, DEFAULT_DANGEROUS_NODE_COMMANDS as t };
