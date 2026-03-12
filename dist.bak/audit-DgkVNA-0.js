import { $t as resolveStateDir, Ut as resolveConfigPath, Zt as resolveOAuthDir } from "./entry.js";
import { A as createConfigIO, C as inspectPathPermissions, Et as normalizeTrustedSafeBinDirs, S as formatPermissionRemediation, an as MAX_INCLUDE_DEPTH, in as INCLUDE_KEY, nt as normalizeNetworkMode, tt as isDangerousNetworkMode, w as safeStat, x as formatPermissionDetail } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { M as resolveAgentModelFallbackValues, N as resolveAgentModelPrimaryValue, d as resolveDefaultAgentId } from "./agent-scope-C2k6BQnt.js";
import { s as normalizeAgentId } from "./session-key-qmb11-mH.js";
import { n as isPathInside, t as extensionUsesSkippedScannerPath } from "./scan-paths-CVkptOYB.js";
import { u as normalizePluginsConfig } from "./manifest-registry-HLdbjiS7.js";
import { n as MANIFEST_KEY } from "./legacy-names-DNgFuAUV.js";
import { l as normalizeStringEntries } from "./dock-B6idJaIX.js";
import { i as loadWorkspaceSkillEntries } from "./skills-DOryi61N.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-CJUwnCYd.js";
import { n as listChannelPlugins } from "./plugins-BOmV0yTv.js";
import { t as GatewayClient } from "./client-C2kv9X_7.js";
import { c as READ_SCOPE, t as buildGatewayConnectionDetails } from "./call-D6IYi30Z.js";
import { t as resolveGatewayCredentialsFromConfig } from "./credentials-DQGpxZLN.js";
import { C as resolveToolProfilePolicy, f as resolveSandboxConfigForAgent, k as SANDBOX_BROWSER_SECURITY_HASH_EPOCH, l as execDockerRaw, m as resolveSandboxToolPolicyForAgent, u as getBlockedBindReason } from "./sandbox-COrmfGkR.js";
import { a as resolveGatewayAuth } from "./auth-ML-4Xoce.js";
import { a as resolveProfile, i as resolveBrowserConfig, s as resolveBrowserControlAuth } from "./server-context-BLhOGtRw.js";
import { n as formatErrorMessage } from "./errors-Cu3BYw29.js";
import { r as resolveMergedSafeBinProfileFixtures, t as listInterpreterLikeSafeBins } from "./exec-safe-bin-runtime-policy-Cr6WvdlO.js";
import { a as resolveNativeSkillsEnabled, i as resolveNativeCommandsEnabled } from "./commands-CQRE0cc7.js";
import { i as readChannelAllowFromStore } from "./pairing-store-CjsmzisR.js";
import { t as listAgentWorkspaceDirs } from "./workspace-dirs-fckC5OJF.js";
import { l as resolveDmAllowState, n as isToolAllowedByPolicies, o as pickSandboxToolPolicy } from "./pi-tools.policy-B6ojB03j.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-C2i9AEgf.js";
import { n as DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "./dangerous-tools-D2c4akyc.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-BgzIw8DX.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-DIBfWMz1.js";
import { i as NODE_SYSTEM_RUN_COMMANDS, r as NODE_SYSTEM_NOTIFY_COMMAND, t as NODE_BROWSER_PROXY_COMMAND } from "./node-commands-2OSlA4bi.js";
import { c as normalizeTelegramAllowFromEntry, s as isNumericTelegramUserId, t as isDiscordMutableAllowEntry } from "./mutable-allowlist-detectors-COMtneie.js";
import { t as inferParamBFromIdOrName } from "./model-param-b-Dir-zlOZ.js";
import path from "node:path";
import JSON5 from "json5";
import * as fs$1 from "node:fs/promises";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

//#region src/gateway/probe.ts
async function probeGateway(opts) {
	const startedAt = Date.now();
	const instanceId = randomUUID();
	let connectLatencyMs = null;
	let connectError = null;
	let close = null;
	return await new Promise((resolve) => {
		let settled = false;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.stop();
			resolve({
				url: opts.url,
				...result
			});
		};
		const client = new GatewayClient({
			url: opts.url,
			token: opts.auth?.token,
			password: opts.auth?.password,
			scopes: [READ_SCOPE],
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			clientVersion: "dev",
			mode: GATEWAY_CLIENT_MODES.PROBE,
			instanceId,
			onConnectError: (err) => {
				connectError = formatErrorMessage(err);
			},
			onClose: (code, reason) => {
				close = {
					code,
					reason
				};
			},
			onHelloOk: async () => {
				connectLatencyMs = Date.now() - startedAt;
				try {
					const [health, status, presence, configSnapshot] = await Promise.all([
						client.request("health"),
						client.request("status"),
						client.request("system-presence"),
						client.request("config.get", {})
					]);
					settle({
						ok: true,
						connectLatencyMs,
						error: null,
						close,
						health,
						status,
						presence: Array.isArray(presence) ? presence : null,
						configSnapshot
					});
				} catch (err) {
					settle({
						ok: false,
						connectLatencyMs,
						error: formatErrorMessage(err),
						close,
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
				}
			}
		});
		const timer = setTimeout(() => {
			settle({
				ok: false,
				connectLatencyMs,
				error: connectError ? `connect failed: ${connectError}` : "timeout",
				close,
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		}, Math.max(250, opts.timeoutMs));
		client.start();
	});
}

//#endregion
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
	unknown: [
		...CANVAS_COMMANDS,
		...CAMERA_COMMANDS,
		...LOCATION_COMMANDS,
		...SYSTEM_COMMANDS
	]
};
function normalizePlatformId(platform, deviceFamily) {
	const raw = (platform ?? "").trim().toLowerCase();
	if (raw.startsWith("ios")) return "ios";
	if (raw.startsWith("android")) return "android";
	if (raw.startsWith("mac")) return "macos";
	if (raw.startsWith("darwin")) return "macos";
	if (raw.startsWith("win")) return "windows";
	if (raw.startsWith("linux")) return "linux";
	const family = (deviceFamily ?? "").trim().toLowerCase();
	if (family.includes("iphone") || family.includes("ipad") || family.includes("ios")) return "ios";
	if (family.includes("android")) return "android";
	if (family.includes("mac")) return "macos";
	if (family.includes("windows")) return "windows";
	if (family.includes("linux")) return "linux";
	return "unknown";
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
//#region src/gateway/probe-auth.ts
function resolveGatewayProbeAuth(params) {
	return resolveGatewayCredentialsFromConfig({
		cfg: params.cfg,
		env: params.env,
		modeOverride: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	});
}

//#endregion
//#region src/security/audit-channel.ts
function normalizeAllowFromList$1(list) {
	return normalizeStringEntries(Array.isArray(list) ? list : void 0);
}
function addDiscordNameBasedEntries(params) {
	if (!Array.isArray(params.values)) return;
	for (const value of params.values) {
		if (!isDiscordMutableAllowEntry(String(value))) continue;
		const text = String(value).trim();
		if (!text) continue;
		params.target.add(`${params.source}:${text}`);
	}
}
function classifyChannelWarningSeverity(message) {
	const s = message.toLowerCase();
	if (s.includes("dms: open") || s.includes("grouppolicy=\"open\"") || s.includes("dmpolicy=\"open\"")) return "critical";
	if (s.includes("allows any") || s.includes("anyone can dm") || s.includes("public")) return "critical";
	if (s.includes("locked") || s.includes("disabled")) return "info";
	return "warn";
}
function dedupeFindings(findings) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const finding of findings) {
		const key = [
			finding.checkId,
			finding.severity,
			finding.title,
			finding.detail ?? "",
			finding.remediation ?? ""
		].join("\n");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(finding);
	}
	return out;
}
function hasExplicitProviderAccountConfig(cfg, provider, accountId) {
	const channel = cfg.channels?.[provider];
	if (!channel || typeof channel !== "object") return false;
	const accounts = channel.accounts;
	if (!accounts || typeof accounts !== "object") return false;
	return accountId in accounts;
}
async function collectChannelSecurityFindings(params) {
	const findings = [];
	const coerceNativeSetting = (value) => {
		if (value === true) return true;
		if (value === false) return false;
		if (value === "auto") return "auto";
	};
	const warnDmPolicy = async (input) => {
		const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
		const { hasWildcard, isMultiUserDm } = await resolveDmAllowState({
			provider: input.provider,
			accountId: input.accountId,
			allowFrom: input.allowFrom,
			normalizeEntry: input.normalizeEntry
		});
		const dmScope = params.cfg.session?.dmScope ?? "main";
		if (input.dmPolicy === "open") {
			const allowFromKey = `${input.allowFromPath}allowFrom`;
			findings.push({
				checkId: `channels.${input.provider}.dm.open`,
				severity: "critical",
				title: `${input.label} DMs are open`,
				detail: `${policyPath}="open" allows anyone to DM the bot.`,
				remediation: `Use pairing/allowlist; if you really need open DMs, ensure ${allowFromKey} includes "*".`
			});
			if (!hasWildcard) findings.push({
				checkId: `channels.${input.provider}.dm.open_invalid`,
				severity: "warn",
				title: `${input.label} DM config looks inconsistent`,
				detail: `"open" requires ${allowFromKey} to include "*".`
			});
		}
		if (input.dmPolicy === "disabled") {
			findings.push({
				checkId: `channels.${input.provider}.dm.disabled`,
				severity: "info",
				title: `${input.label} DMs are disabled`,
				detail: `${policyPath}="disabled" ignores inbound DMs.`
			});
			return;
		}
		if (dmScope === "main" && isMultiUserDm) findings.push({
			checkId: `channels.${input.provider}.dm.scope_main_multiuser`,
			severity: "warn",
			title: `${input.label} DMs share the main session`,
			detail: "Multiple DM senders currently share the main session, which can leak context across users.",
			remediation: "Run: " + formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") + " (or \"per-account-channel-peer\" for multi-account channels) to isolate DM sessions per sender."
		});
	};
	for (const plugin of params.plugins) {
		if (!plugin.security) continue;
		const accountIds = plugin.config.listAccountIds(params.cfg);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg: params.cfg,
			accountIds
		});
		const orderedAccountIds = Array.from(new Set([defaultAccountId, ...accountIds]));
		for (const accountId of orderedAccountIds) {
			const hasExplicitAccountPath = hasExplicitProviderAccountConfig(params.cfg, plugin.id, accountId);
			const account = plugin.config.resolveAccount(params.cfg, accountId);
			if (!(plugin.config.isEnabled ? plugin.config.isEnabled(account, params.cfg) : true)) continue;
			if (!(plugin.config.isConfigured ? await plugin.config.isConfigured(account, params.cfg) : true)) continue;
			const accountConfig = account?.config;
			if (isDangerousNameMatchingEnabled(accountConfig)) {
				const accountNote = orderedAccountIds.length > 1 || hasExplicitAccountPath ? ` (account: ${accountId})` : "";
				findings.push({
					checkId: `channels.${plugin.id}.allowFrom.dangerous_name_matching_enabled`,
					severity: "info",
					title: `${plugin.meta.label ?? plugin.id} dangerous name matching is enabled${accountNote}`,
					detail: "dangerouslyAllowNameMatching=true re-enables mutable name/email/tag matching for sender authorization. This is a break-glass compatibility mode, not a hardened default.",
					remediation: "Prefer stable sender IDs in allowlists, then disable dangerouslyAllowNameMatching."
				});
			}
			if (plugin.id === "discord") {
				const discordCfg = account?.config ?? {};
				const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(discordCfg);
				const storeAllowFrom = await readChannelAllowFromStore("discord", process.env, accountId).catch(() => []);
				const discordNameBasedAllowEntries = /* @__PURE__ */ new Set();
				const discordPathPrefix = orderedAccountIds.length > 1 || hasExplicitAccountPath ? `channels.discord.accounts.${accountId}` : "channels.discord";
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: discordCfg.allowFrom,
					source: `${discordPathPrefix}.allowFrom`
				});
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: discordCfg.dm?.allowFrom,
					source: `${discordPathPrefix}.dm.allowFrom`
				});
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: storeAllowFrom,
					source: "~/.openclaw/credentials/discord-allowFrom.json"
				});
				const discordGuildEntries = discordCfg.guilds ?? {};
				for (const [guildKey, guildValue] of Object.entries(discordGuildEntries)) {
					if (!guildValue || typeof guildValue !== "object") continue;
					const guild = guildValue;
					addDiscordNameBasedEntries({
						target: discordNameBasedAllowEntries,
						values: guild.users,
						source: `${discordPathPrefix}.guilds.${guildKey}.users`
					});
					const channels = guild.channels;
					if (!channels || typeof channels !== "object") continue;
					for (const [channelKey, channelValue] of Object.entries(channels)) {
						if (!channelValue || typeof channelValue !== "object") continue;
						addDiscordNameBasedEntries({
							target: discordNameBasedAllowEntries,
							values: channelValue.users,
							source: `${discordPathPrefix}.guilds.${guildKey}.channels.${channelKey}.users`
						});
					}
				}
				if (discordNameBasedAllowEntries.size > 0) {
					const examples = Array.from(discordNameBasedAllowEntries).slice(0, 5);
					const more = discordNameBasedAllowEntries.size > examples.length ? ` (+${discordNameBasedAllowEntries.size - examples.length} more)` : "";
					findings.push({
						checkId: "channels.discord.allowFrom.name_based_entries",
						severity: dangerousNameMatchingEnabled ? "info" : "warn",
						title: dangerousNameMatchingEnabled ? "Discord allowlist uses break-glass name/tag matching" : "Discord allowlist contains name or tag entries",
						detail: dangerousNameMatchingEnabled ? `Discord name/tag allowlist matching is explicitly enabled via dangerouslyAllowNameMatching. This mutable-identity mode is operator-selected break-glass behavior and out-of-scope for vulnerability reports by itself. Found: ${examples.join(", ")}${more}.` : `Discord name/tag allowlist matching uses normalized slugs and can collide across users. Found: ${examples.join(", ")}${more}.`,
						remediation: dangerousNameMatchingEnabled ? "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>), then disable dangerouslyAllowNameMatching." : "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>) in channels.discord.allowFrom and channels.discord.guilds.*.users, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept the risk."
					});
				}
				const nativeEnabled = resolveNativeCommandsEnabled({
					providerId: "discord",
					providerSetting: coerceNativeSetting(discordCfg.commands?.native),
					globalSetting: params.cfg.commands?.native
				});
				const nativeSkillsEnabled = resolveNativeSkillsEnabled({
					providerId: "discord",
					providerSetting: coerceNativeSetting(discordCfg.commands?.nativeSkills),
					globalSetting: params.cfg.commands?.nativeSkills
				});
				if (nativeEnabled || nativeSkillsEnabled) {
					const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
					const groupPolicy = discordCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
					const guildEntries = discordGuildEntries;
					const guildsConfigured = Object.keys(guildEntries).length > 0;
					const hasAnyUserAllowlist = Object.values(guildEntries).some((guild) => {
						if (!guild || typeof guild !== "object") return false;
						const g = guild;
						if (Array.isArray(g.users) && g.users.length > 0) return true;
						const channels = g.channels;
						if (!channels || typeof channels !== "object") return false;
						return Object.values(channels).some((channel) => {
							if (!channel || typeof channel !== "object") return false;
							const c = channel;
							return Array.isArray(c.users) && c.users.length > 0;
						});
					});
					const dmAllowFromRaw = discordCfg.dm?.allowFrom;
					const ownerAllowFromConfigured = normalizeAllowFromList$1([...Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [], ...storeAllowFrom]).length > 0;
					const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
					if (!useAccessGroups && groupPolicy !== "disabled" && guildsConfigured && !hasAnyUserAllowlist) findings.push({
						checkId: "channels.discord.commands.native.unrestricted",
						severity: "critical",
						title: "Discord slash commands are unrestricted",
						detail: "commands.useAccessGroups=false disables sender allowlists for Discord slash commands unless a per-guild/channel users allowlist is configured; with no users allowlist, any user in allowed guild channels can invoke /… commands.",
						remediation: "Set commands.useAccessGroups=true (recommended), or configure channels.discord.guilds.<id>.users (or channels.discord.guilds.<id>.channels.<channel>.users)."
					});
					else if (useAccessGroups && groupPolicy !== "disabled" && guildsConfigured && !ownerAllowFromConfigured && !hasAnyUserAllowlist) findings.push({
						checkId: "channels.discord.commands.native.no_allowlists",
						severity: "warn",
						title: "Discord slash commands have no allowlists",
						detail: "Discord slash commands are enabled, but neither an owner allowFrom list nor any per-guild/channel users allowlist is configured; /… commands will be rejected for everyone.",
						remediation: "Add your user id to channels.discord.allowFrom (or approve yourself via pairing), or configure channels.discord.guilds.<id>.users."
					});
				}
			}
			if (plugin.id === "slack") {
				const slackCfg = account?.config ?? {};
				const nativeEnabled = resolveNativeCommandsEnabled({
					providerId: "slack",
					providerSetting: coerceNativeSetting(slackCfg.commands?.native),
					globalSetting: params.cfg.commands?.native
				});
				const nativeSkillsEnabled = resolveNativeSkillsEnabled({
					providerId: "slack",
					providerSetting: coerceNativeSetting(slackCfg.commands?.nativeSkills),
					globalSetting: params.cfg.commands?.nativeSkills
				});
				if (nativeEnabled || nativeSkillsEnabled || slackCfg.slashCommand?.enabled === true) if (!(params.cfg.commands?.useAccessGroups !== false)) findings.push({
					checkId: "channels.slack.commands.slash.useAccessGroups_off",
					severity: "critical",
					title: "Slack slash commands bypass access groups",
					detail: "Slack slash/native commands are enabled while commands.useAccessGroups=false; this can allow unrestricted /… command execution from channels/users you didn't explicitly authorize.",
					remediation: "Set commands.useAccessGroups=true (recommended)."
				});
				else {
					const allowFromRaw = account?.config?.allowFrom;
					const legacyAllowFromRaw = account?.dm?.allowFrom;
					const allowFrom = Array.isArray(allowFromRaw) ? allowFromRaw : Array.isArray(legacyAllowFromRaw) ? legacyAllowFromRaw : [];
					const storeAllowFrom = await readChannelAllowFromStore("slack", process.env, accountId).catch(() => []);
					const ownerAllowFromConfigured = normalizeAllowFromList$1([...allowFrom, ...storeAllowFrom]).length > 0;
					const channels = slackCfg.channels ?? {};
					const hasAnyChannelUsersAllowlist = Object.values(channels).some((value) => {
						if (!value || typeof value !== "object") return false;
						const channel = value;
						return Array.isArray(channel.users) && channel.users.length > 0;
					});
					if (!ownerAllowFromConfigured && !hasAnyChannelUsersAllowlist) findings.push({
						checkId: "channels.slack.commands.slash.no_allowlists",
						severity: "warn",
						title: "Slack slash commands have no allowlists",
						detail: "Slack slash/native commands are enabled, but neither an owner allowFrom list nor any channels.<id>.users allowlist is configured; /… commands will be rejected for everyone.",
						remediation: "Approve yourself via pairing (recommended), or set channels.slack.allowFrom and/or channels.slack.channels.<id>.users."
					});
				}
			}
			const dmPolicy = plugin.security.resolveDmPolicy?.({
				cfg: params.cfg,
				accountId,
				account
			});
			if (dmPolicy) await warnDmPolicy({
				label: plugin.meta.label ?? plugin.id,
				provider: plugin.id,
				accountId,
				dmPolicy: dmPolicy.policy,
				allowFrom: dmPolicy.allowFrom,
				policyPath: dmPolicy.policyPath,
				allowFromPath: dmPolicy.allowFromPath,
				normalizeEntry: dmPolicy.normalizeEntry
			});
			if (plugin.security.collectWarnings) {
				const warnings = await plugin.security.collectWarnings({
					cfg: params.cfg,
					accountId,
					account
				});
				for (const message of warnings ?? []) {
					const trimmed = String(message).trim();
					if (!trimmed) continue;
					findings.push({
						checkId: `channels.${plugin.id}.warning.${findings.length + 1}`,
						severity: classifyChannelWarningSeverity(trimmed),
						title: `${plugin.meta.label ?? plugin.id} security warning`,
						detail: trimmed.replace(/^-\s*/, "")
					});
				}
			}
			if (plugin.id !== "telegram") continue;
			if (!(params.cfg.commands?.text !== false)) continue;
			const telegramCfg = account?.config ?? {};
			const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
			const groupPolicy = telegramCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
			const groups = telegramCfg.groups;
			const groupsConfigured = Boolean(groups) && Object.keys(groups ?? {}).length > 0;
			if (!(groupPolicy === "open" || groupPolicy === "allowlist" && groupsConfigured)) continue;
			const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
			const storeHasWildcard = storeAllowFrom.some((v) => String(v).trim() === "*");
			const invalidTelegramAllowFromEntries = /* @__PURE__ */ new Set();
			for (const entry of storeAllowFrom) {
				const normalized = normalizeTelegramAllowFromEntry(entry);
				if (!normalized || normalized === "*") continue;
				if (!isNumericTelegramUserId(normalized)) invalidTelegramAllowFromEntries.add(normalized);
			}
			const groupAllowFrom = Array.isArray(telegramCfg.groupAllowFrom) ? telegramCfg.groupAllowFrom : [];
			const groupAllowFromHasWildcard = groupAllowFrom.some((v) => String(v).trim() === "*");
			for (const entry of groupAllowFrom) {
				const normalized = normalizeTelegramAllowFromEntry(entry);
				if (!normalized || normalized === "*") continue;
				if (!isNumericTelegramUserId(normalized)) invalidTelegramAllowFromEntries.add(normalized);
			}
			const dmAllowFrom = Array.isArray(telegramCfg.allowFrom) ? telegramCfg.allowFrom : [];
			for (const entry of dmAllowFrom) {
				const normalized = normalizeTelegramAllowFromEntry(entry);
				if (!normalized || normalized === "*") continue;
				if (!isNumericTelegramUserId(normalized)) invalidTelegramAllowFromEntries.add(normalized);
			}
			const anyGroupOverride = Boolean(groups && Object.values(groups).some((value) => {
				if (!value || typeof value !== "object") return false;
				const group = value;
				const allowFrom = Array.isArray(group.allowFrom) ? group.allowFrom : [];
				if (allowFrom.length > 0) {
					for (const entry of allowFrom) {
						const normalized = normalizeTelegramAllowFromEntry(entry);
						if (!normalized || normalized === "*") continue;
						if (!isNumericTelegramUserId(normalized)) invalidTelegramAllowFromEntries.add(normalized);
					}
					return true;
				}
				const topics = group.topics;
				if (!topics || typeof topics !== "object") return false;
				return Object.values(topics).some((topicValue) => {
					if (!topicValue || typeof topicValue !== "object") return false;
					const topic = topicValue;
					const topicAllow = Array.isArray(topic.allowFrom) ? topic.allowFrom : [];
					for (const entry of topicAllow) {
						const normalized = normalizeTelegramAllowFromEntry(entry);
						if (!normalized || normalized === "*") continue;
						if (!isNumericTelegramUserId(normalized)) invalidTelegramAllowFromEntries.add(normalized);
					}
					return topicAllow.length > 0;
				});
			}));
			const hasAnySenderAllowlist = storeAllowFrom.length > 0 || groupAllowFrom.length > 0 || anyGroupOverride;
			if (invalidTelegramAllowFromEntries.size > 0) {
				const examples = Array.from(invalidTelegramAllowFromEntries).slice(0, 5);
				const more = invalidTelegramAllowFromEntries.size > examples.length ? ` (+${invalidTelegramAllowFromEntries.size - examples.length} more)` : "";
				findings.push({
					checkId: "channels.telegram.allowFrom.invalid_entries",
					severity: "warn",
					title: "Telegram allowlist contains non-numeric entries",
					detail: `Telegram sender authorization requires numeric Telegram user IDs. Found non-numeric allowFrom entries: ${examples.join(", ")}${more}.`,
					remediation: "Replace @username entries with numeric Telegram user IDs (use onboarding to resolve), then re-run the audit."
				});
			}
			if (storeHasWildcard || groupAllowFromHasWildcard) {
				findings.push({
					checkId: "channels.telegram.groups.allowFrom.wildcard",
					severity: "critical",
					title: "Telegram group allowlist contains wildcard",
					detail: "Telegram group sender allowlist contains \"*\", which allows any group member to run /… commands and control directives.",
					remediation: "Remove \"*\" from channels.telegram.groupAllowFrom and pairing store; prefer explicit numeric Telegram user IDs."
				});
				continue;
			}
			if (!hasAnySenderAllowlist) {
				const providerSetting = telegramCfg.commands?.nativeSkills;
				const skillsEnabled = resolveNativeSkillsEnabled({
					providerId: "telegram",
					providerSetting,
					globalSetting: params.cfg.commands?.nativeSkills
				});
				findings.push({
					checkId: "channels.telegram.groups.allowFrom.missing",
					severity: "critical",
					title: "Telegram group commands have no sender allowlist",
					detail: `Telegram group access is enabled but no sender allowlist is configured; this allows any group member to invoke /… commands` + (skillsEnabled ? " (including skill commands)." : "."),
					remediation: "Approve yourself via pairing (recommended), or set channels.telegram.groupAllowFrom (or per-group groups.<id>.allowFrom)."
				});
			}
		}
	}
	return dedupeFindings(findings);
}

//#endregion
//#region src/security/audit-extra.sync.ts
const SMALL_MODEL_PARAM_B_MAX = 300;
function summarizeGroupPolicy(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		open: 0,
		allowlist: 0,
		other: 0
	};
	let open = 0;
	let allowlist = 0;
	let other = 0;
	for (const value of Object.values(channels)) {
		if (!value || typeof value !== "object") continue;
		const policy = value.groupPolicy;
		if (policy === "open") open += 1;
		else if (policy === "allowlist") allowlist += 1;
		else other += 1;
	}
	return {
		open,
		allowlist,
		other
	};
}
function isProbablySyncedPath(p) {
	const s = p.toLowerCase();
	return s.includes("icloud") || s.includes("dropbox") || s.includes("google drive") || s.includes("googledrive") || s.includes("onedrive");
}
function looksLikeEnvRef(value) {
	const v = value.trim();
	return v.startsWith("${") && v.endsWith("}");
}
function isGatewayRemotelyExposed(cfg) {
	if ((typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback") !== "loopback") return true;
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	return tailscaleMode === "serve" || tailscaleMode === "funnel";
}
function addModel(models, raw, source) {
	if (typeof raw !== "string") return;
	const id = raw.trim();
	if (!id) return;
	models.push({
		id,
		source
	});
}
function collectModels(cfg) {
	const out = [];
	addModel(out, resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model), "agents.defaults.model.primary");
	for (const f of resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)) addModel(out, f, "agents.defaults.model.fallbacks");
	addModel(out, resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel), "agents.defaults.imageModel.primary");
	for (const f of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) addModel(out, f, "agents.defaults.imageModel.fallbacks");
	const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
	for (const agent of list ?? []) {
		if (!agent || typeof agent !== "object") continue;
		const id = typeof agent.id === "string" ? agent.id : "";
		const model = agent.model;
		if (typeof model === "string") addModel(out, model, `agents.list.${id}.model`);
		else if (model && typeof model === "object") {
			addModel(out, model.primary, `agents.list.${id}.model.primary`);
			const fallbacks = model.fallbacks;
			if (Array.isArray(fallbacks)) for (const f of fallbacks) addModel(out, f, `agents.list.${id}.model.fallbacks`);
		}
	}
	return out;
}
const LEGACY_MODEL_PATTERNS = [
	{
		id: "openai.gpt35",
		re: /\bgpt-3\.5\b/i,
		label: "GPT-3.5 family"
	},
	{
		id: "anthropic.claude2",
		re: /\bclaude-(instant|2)\b/i,
		label: "Claude 2/Instant family"
	},
	{
		id: "openai.gpt4_legacy",
		re: /\bgpt-4-(0314|0613)\b/i,
		label: "Legacy GPT-4 snapshots"
	}
];
const WEAK_TIER_MODEL_PATTERNS = [{
	id: "anthropic.haiku",
	re: /\bhaiku\b/i,
	label: "Haiku tier (smaller model)"
}];
function isGptModel(id) {
	return /\bgpt-/i.test(id);
}
function isGpt5OrHigher(id) {
	return /\bgpt-5(?:\b|[.-])/i.test(id);
}
function isClaudeModel(id) {
	return /\bclaude-/i.test(id);
}
function isClaude45OrHigher(id) {
	return /\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i.test(id);
}
function extractAgentIdFromSource(source) {
	return source.match(/^agents\.list\.([^.]*)\./)?.[1] ?? null;
}
function hasConfiguredDockerConfig(docker) {
	if (!docker || typeof docker !== "object") return false;
	return Object.values(docker).some((value) => value !== void 0);
}
function normalizeNodeCommand(value) {
	return typeof value === "string" ? value.trim() : "";
}
function listKnownNodeCommands(cfg) {
	const baseCfg = {
		...cfg,
		gateway: {
			...cfg.gateway,
			nodes: {
				...cfg.gateway?.nodes,
				denyCommands: []
			}
		}
	};
	const out = /* @__PURE__ */ new Set();
	for (const platform of [
		"ios",
		"android",
		"macos",
		"linux",
		"windows",
		"unknown"
	]) {
		const allow = resolveNodeCommandAllowlist(baseCfg, { platform });
		for (const cmd of allow) {
			const normalized = normalizeNodeCommand(cmd);
			if (normalized) out.add(normalized);
		}
	}
	return out;
}
function looksLikeNodeCommandPattern(value) {
	if (!value) return false;
	if (/[?*[\]{}(),|]/.test(value)) return true;
	if (value.startsWith("/") || value.endsWith("/") || value.startsWith("^") || value.endsWith("$")) return true;
	return /\s/.test(value) || value.includes("group:");
}
function resolveToolPolicies$1(params) {
	const policies = [];
	const profilePolicy = resolveToolProfilePolicy(params.agentTools?.profile ?? params.cfg.tools?.profile);
	if (profilePolicy) policies.push(profilePolicy);
	const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? void 0);
	if (globalPolicy) policies.push(globalPolicy);
	const agentPolicy = pickSandboxToolPolicy(params.agentTools);
	if (agentPolicy) policies.push(agentPolicy);
	if (params.sandboxMode === "all") {
		const sandboxPolicy = resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? void 0);
		policies.push(sandboxPolicy);
	}
	return policies;
}
function hasWebSearchKey(cfg, env) {
	const search = cfg.tools?.web?.search;
	return Boolean(search?.apiKey || search?.perplexity?.apiKey || env.BRAVE_API_KEY || env.PERPLEXITY_API_KEY || env.OPENROUTER_API_KEY);
}
function isWebSearchEnabled(cfg, env) {
	const enabled = cfg.tools?.web?.search?.enabled;
	if (enabled === false) return false;
	if (enabled === true) return true;
	return hasWebSearchKey(cfg, env);
}
function isWebFetchEnabled(cfg) {
	if (cfg.tools?.web?.fetch?.enabled === false) return false;
	return true;
}
function isBrowserEnabled(cfg) {
	try {
		return resolveBrowserConfig(cfg.browser, cfg).enabled;
	} catch {
		return true;
	}
}
function listGroupPolicyOpen(cfg) {
	const out = [];
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return out;
	for (const [channelId, value] of Object.entries(channels)) {
		if (!value || typeof value !== "object") continue;
		const section = value;
		if (section.groupPolicy === "open") out.push(`channels.${channelId}.groupPolicy`);
		const accounts = section.accounts;
		if (accounts && typeof accounts === "object") for (const [accountId, accountVal] of Object.entries(accounts)) {
			if (!accountVal || typeof accountVal !== "object") continue;
			if (accountVal.groupPolicy === "open") out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
		}
	}
	return out;
}
function hasConfiguredGroupTargets(section) {
	return [
		"groups",
		"guilds",
		"channels",
		"rooms"
	].some((key) => {
		const value = section[key];
		return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
	});
}
function listPotentialMultiUserSignals(cfg) {
	const out = /* @__PURE__ */ new Set();
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return [];
	const inspectSection = (section, basePath) => {
		const groupPolicy = typeof section.groupPolicy === "string" ? section.groupPolicy : null;
		if (groupPolicy === "open") out.add(`${basePath}.groupPolicy="open"`);
		else if (groupPolicy === "allowlist" && hasConfiguredGroupTargets(section)) out.add(`${basePath}.groupPolicy="allowlist" with configured group targets`);
		if ((typeof section.dmPolicy === "string" ? section.dmPolicy : null) === "open") out.add(`${basePath}.dmPolicy="open"`);
		if ((Array.isArray(section.allowFrom) ? section.allowFrom : []).some((entry) => String(entry).trim() === "*")) out.add(`${basePath}.allowFrom includes "*"`);
		if ((Array.isArray(section.groupAllowFrom) ? section.groupAllowFrom : []).some((entry) => String(entry).trim() === "*")) out.add(`${basePath}.groupAllowFrom includes "*"`);
		const dm = section.dm;
		if (dm && typeof dm === "object") {
			const dmSection = dm;
			if ((typeof dmSection.policy === "string" ? dmSection.policy : null) === "open") out.add(`${basePath}.dm.policy="open"`);
			if ((Array.isArray(dmSection.allowFrom) ? dmSection.allowFrom : []).some((entry) => String(entry).trim() === "*")) out.add(`${basePath}.dm.allowFrom includes "*"`);
		}
	};
	for (const [channelId, value] of Object.entries(channels)) {
		if (!value || typeof value !== "object") continue;
		const section = value;
		inspectSection(section, `channels.${channelId}`);
		const accounts = section.accounts;
		if (!accounts || typeof accounts !== "object") continue;
		for (const [accountId, accountValue] of Object.entries(accounts)) {
			if (!accountValue || typeof accountValue !== "object") continue;
			inspectSection(accountValue, `channels.${channelId}.accounts.${accountId}`);
		}
	}
	return Array.from(out);
}
function collectRiskyToolExposureContexts(cfg) {
	const contexts = [{ label: "agents.defaults" }];
	for (const agent of cfg.agents?.list ?? []) {
		if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
		contexts.push({
			label: `agents.list.${agent.id}`,
			agentId: agent.id,
			tools: agent.tools
		});
	}
	const riskyContexts = [];
	let hasRuntimeRisk = false;
	for (const context of contexts) {
		const sandboxMode = resolveSandboxConfigForAgent(cfg, context.agentId).mode;
		const policies = resolveToolPolicies$1({
			cfg,
			agentTools: context.tools,
			sandboxMode,
			agentId: context.agentId ?? null
		});
		const runtimeTools = ["exec", "process"].filter((tool) => isToolAllowedByPolicies(tool, policies));
		const fsTools = [
			"read",
			"write",
			"edit",
			"apply_patch"
		].filter((tool) => isToolAllowedByPolicies(tool, policies));
		const fsWorkspaceOnly = context.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly;
		const runtimeUnguarded = runtimeTools.length > 0 && sandboxMode !== "all";
		const fsUnguarded = fsTools.length > 0 && sandboxMode !== "all" && fsWorkspaceOnly !== true;
		if (!runtimeUnguarded && !fsUnguarded) continue;
		if (runtimeUnguarded) hasRuntimeRisk = true;
		riskyContexts.push(`${context.label} (sandbox=${sandboxMode}; runtime=[${runtimeTools.join(", ") || "off"}]; fs=[${fsTools.join(", ") || "off"}]; fs.workspaceOnly=${fsWorkspaceOnly === true ? "true" : "false"})`);
	}
	return {
		riskyContexts,
		hasRuntimeRisk
	};
}
function collectAttackSurfaceSummaryFindings(cfg) {
	const group = summarizeGroupPolicy(cfg);
	const elevated = cfg.tools?.elevated?.enabled !== false;
	const webhooksEnabled = cfg.hooks?.enabled === true;
	const internalHooksEnabled = cfg.hooks?.internal?.enabled === true;
	const browserEnabled = cfg.browser?.enabled ?? true;
	return [{
		checkId: "summary.attack_surface",
		severity: "info",
		title: "Attack surface summary",
		detail: `groups: open=${group.open}, allowlist=${group.allowlist}\ntools.elevated: ${elevated ? "enabled" : "disabled"}\nhooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}\nhooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}\nbrowser control: ${browserEnabled ? "enabled" : "disabled"}\ntrust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway`
	}];
}
function collectSyncedFolderFindings(params) {
	const findings = [];
	if (isProbablySyncedPath(params.stateDir) || isProbablySyncedPath(params.configPath)) findings.push({
		checkId: "fs.synced_dir",
		severity: "warn",
		title: "State/config path looks like a synced folder",
		detail: `stateDir=${params.stateDir}, configPath=${params.configPath}. Synced folders (iCloud/Dropbox/OneDrive/Google Drive) can leak tokens and transcripts onto other devices.`,
		remediation: `Keep OPENCLAW_STATE_DIR on a local-only volume and re-run "${formatCliCommand("openclaw security audit --fix")}".`
	});
	return findings;
}
function collectSecretsInConfigFindings(cfg) {
	const findings = [];
	const password = typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway.auth.password.trim() : "";
	if (password && !looksLikeEnvRef(password)) findings.push({
		checkId: "config.secrets.gateway_password_in_config",
		severity: "warn",
		title: "Gateway password is stored in config",
		detail: "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
		remediation: "Prefer OPENCLAW_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk."
	});
	const hooksToken = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
	if (cfg.hooks?.enabled === true && hooksToken && !looksLikeEnvRef(hooksToken)) findings.push({
		checkId: "config.secrets.hooks_token_in_config",
		severity: "info",
		title: "Hooks token is stored in config",
		detail: "hooks.token is set in the config file; keep config perms tight and treat it like an API secret."
	});
	return findings;
}
function collectHooksHardeningFindings(cfg, env = process.env) {
	const findings = [];
	if (cfg.hooks?.enabled !== true) return findings;
	const token = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
	if (token && token.length < 24) findings.push({
		checkId: "hooks.token_too_short",
		severity: "warn",
		title: "Hooks token looks short",
		detail: `hooks.token is ${token.length} chars; prefer a long random token.`
	});
	const gatewayAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
		env
	});
	const openclawGatewayToken = typeof env.OPENCLAW_GATEWAY_TOKEN === "string" && env.OPENCLAW_GATEWAY_TOKEN.trim() ? env.OPENCLAW_GATEWAY_TOKEN.trim() : null;
	const gatewayToken = gatewayAuth.mode === "token" && typeof gatewayAuth.token === "string" && gatewayAuth.token.trim() ? gatewayAuth.token.trim() : openclawGatewayToken ? openclawGatewayToken : null;
	if (token && gatewayToken && token === gatewayToken) findings.push({
		checkId: "hooks.token_reuse_gateway_token",
		severity: "critical",
		title: "Hooks token reuses the Gateway token",
		detail: "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
		remediation: "Use a separate hooks.token dedicated to hook ingress."
	});
	if ((typeof cfg.hooks?.path === "string" ? cfg.hooks.path.trim() : "") === "/") findings.push({
		checkId: "hooks.path_root",
		severity: "critical",
		title: "Hooks base path is '/'",
		detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
		remediation: "Use a dedicated path like '/hooks'."
	});
	const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
	const defaultSessionKey = typeof cfg.hooks?.defaultSessionKey === "string" ? cfg.hooks.defaultSessionKey.trim() : "";
	const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes) ? cfg.hooks.allowedSessionKeyPrefixes.map((prefix) => prefix.trim()).filter((prefix) => prefix.length > 0) : [];
	const remoteExposure = isGatewayRemotelyExposed(cfg);
	if (!defaultSessionKey) findings.push({
		checkId: "hooks.default_session_key_unset",
		severity: "warn",
		title: "hooks.defaultSessionKey is not configured",
		detail: "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
		remediation: "Set hooks.defaultSessionKey (for example, \"hook:ingress\")."
	});
	if (allowRequestSessionKey) findings.push({
		checkId: "hooks.request_session_key_enabled",
		severity: remoteExposure ? "critical" : "warn",
		title: "External hook payloads may override sessionKey",
		detail: "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
		remediation: "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes."
	});
	if (allowRequestSessionKey && allowedPrefixes.length === 0) findings.push({
		checkId: "hooks.request_session_key_prefixes_missing",
		severity: remoteExposure ? "critical" : "warn",
		title: "Request sessionKey override is enabled without prefix restrictions",
		detail: "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
		remediation: "Set hooks.allowedSessionKeyPrefixes (for example, [\"hook:\"]) or disable request overrides."
	});
	return findings;
}
function collectGatewayHttpSessionKeyOverrideFindings(cfg) {
	const findings = [];
	const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
	const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
	if (!chatCompletionsEnabled && !responsesEnabled) return findings;
	const enabledEndpoints = [chatCompletionsEnabled ? "/v1/chat/completions" : null, responsesEnabled ? "/v1/responses" : null].filter((entry) => Boolean(entry));
	findings.push({
		checkId: "gateway.http.session_key_override_enabled",
		severity: "info",
		title: "HTTP API session-key override is enabled",
		detail: `${enabledEndpoints.join(", ")} accept x-openclaw-session-key for per-request session routing. Treat API credential holders as trusted principals.`
	});
	return findings;
}
function collectGatewayHttpNoAuthFindings(cfg, env) {
	const findings = [];
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	if (resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode,
		env
	}).mode !== "none") return findings;
	const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
	const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
	const enabledEndpoints = [
		"/tools/invoke",
		chatCompletionsEnabled ? "/v1/chat/completions" : null,
		responsesEnabled ? "/v1/responses" : null
	].filter((entry) => Boolean(entry));
	const remoteExposure = isGatewayRemotelyExposed(cfg);
	findings.push({
		checkId: "gateway.http.no_auth",
		severity: remoteExposure ? "critical" : "warn",
		title: "Gateway HTTP APIs are reachable without auth",
		detail: `gateway.auth.mode="none" leaves ${enabledEndpoints.join(", ")} callable without a shared secret. Treat this as trusted-local only and avoid exposing the gateway beyond loopback.`,
		remediation: "Set gateway.auth.mode to token/password (recommended). If you intentionally keep mode=none, keep gateway.bind=loopback and disable optional HTTP endpoints."
	});
	return findings;
}
function collectSandboxDockerNoopFindings(cfg) {
	const findings = [];
	const configuredPaths = [];
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const defaultsSandbox = cfg.agents?.defaults?.sandbox;
	const hasDefaultDocker = hasConfiguredDockerConfig(defaultsSandbox?.docker);
	const defaultMode = defaultsSandbox?.mode ?? "off";
	const hasAnySandboxEnabledAgent = agents.some((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return false;
		return resolveSandboxConfigForAgent(cfg, entry.id).mode !== "off";
	});
	if (hasDefaultDocker && defaultMode === "off" && !hasAnySandboxEnabledAgent) configuredPaths.push("agents.defaults.sandbox.docker");
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		if (!hasConfiguredDockerConfig(entry.sandbox?.docker)) continue;
		if (resolveSandboxConfigForAgent(cfg, entry.id).mode === "off") configuredPaths.push(`agents.list.${entry.id}.sandbox.docker`);
	}
	if (configuredPaths.length === 0) return findings;
	findings.push({
		checkId: "sandbox.docker_config_mode_off",
		severity: "warn",
		title: "Sandbox docker settings configured while sandbox mode is off",
		detail: "These docker settings will not take effect until sandbox mode is enabled:\n" + configuredPaths.map((entry) => `- ${entry}`).join("\n"),
		remediation: "Enable sandbox mode (`agents.defaults.sandbox.mode=\"non-main\"` or `\"all\"`) where needed, or remove unused docker settings."
	});
	return findings;
}
function collectSandboxDangerousConfigFindings(cfg) {
	const findings = [];
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const configs = [];
	const defaultDocker = cfg.agents?.defaults?.sandbox?.docker;
	if (defaultDocker && typeof defaultDocker === "object") configs.push({
		source: "agents.defaults.sandbox.docker",
		docker: defaultDocker
	});
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		const agentDocker = entry.sandbox?.docker;
		if (agentDocker && typeof agentDocker === "object") configs.push({
			source: `agents.list.${entry.id}.sandbox.docker`,
			docker: agentDocker
		});
	}
	for (const { source, docker } of configs) {
		const binds = Array.isArray(docker.binds) ? docker.binds : [];
		for (const bind of binds) {
			if (typeof bind !== "string") continue;
			const blocked = getBlockedBindReason(bind);
			if (!blocked) continue;
			if (blocked.kind === "non_absolute") {
				findings.push({
					checkId: "sandbox.bind_mount_non_absolute",
					severity: "warn",
					title: "Sandbox bind mount uses a non-absolute source path",
					detail: `${source}.binds contains "${bind}" which uses source path "${blocked.sourcePath}". Non-absolute bind sources are hard to validate safely and may resolve unexpectedly.`,
					remediation: `Rewrite "${bind}" to use an absolute host path (for example: /home/user/project:/project:ro).`
				});
				continue;
			}
			if (blocked.kind !== "covers" && blocked.kind !== "targets") continue;
			const verb = blocked.kind === "covers" ? "covers" : "targets";
			findings.push({
				checkId: "sandbox.dangerous_bind_mount",
				severity: "critical",
				title: "Dangerous bind mount in sandbox config",
				detail: `${source}.binds contains "${bind}" which ${verb} blocked path "${blocked.blockedPath}". This can expose host system directories or the Docker socket to sandbox containers.`,
				remediation: `Remove "${bind}" from ${source}.binds. Use project-specific paths instead.`
			});
		}
		const network = typeof docker.network === "string" ? docker.network : void 0;
		const normalizedNetwork = normalizeNetworkMode(network);
		if (isDangerousNetworkMode(network)) {
			const modeLabel = normalizedNetwork === "host" ? "\"host\"" : `"${network}"`;
			const detail = normalizedNetwork === "host" ? `${source}.network is "host" which bypasses container network isolation entirely.` : `${source}.network is ${modeLabel} which joins another container namespace and can bypass sandbox network isolation.`;
			findings.push({
				checkId: "sandbox.dangerous_network_mode",
				severity: "critical",
				title: "Dangerous network mode in sandbox config",
				detail,
				remediation: `Set ${source}.network to "bridge", "none", or a custom bridge network name. Use ${source}.dangerouslyAllowContainerNamespaceJoin=true only as a break-glass override when you fully trust this runtime.`
			});
		}
		const seccompProfile = typeof docker.seccompProfile === "string" ? docker.seccompProfile : void 0;
		if (seccompProfile && seccompProfile.trim().toLowerCase() === "unconfined") findings.push({
			checkId: "sandbox.dangerous_seccomp_profile",
			severity: "critical",
			title: "Seccomp unconfined in sandbox config",
			detail: `${source}.seccompProfile is "unconfined" which disables syscall filtering.`,
			remediation: `Remove ${source}.seccompProfile or use a custom seccomp profile file.`
		});
		const apparmorProfile = typeof docker.apparmorProfile === "string" ? docker.apparmorProfile : void 0;
		if (apparmorProfile && apparmorProfile.trim().toLowerCase() === "unconfined") findings.push({
			checkId: "sandbox.dangerous_apparmor_profile",
			severity: "critical",
			title: "AppArmor unconfined in sandbox config",
			detail: `${source}.apparmorProfile is "unconfined" which disables AppArmor enforcement.`,
			remediation: `Remove ${source}.apparmorProfile or use a named AppArmor profile.`
		});
	}
	const browserExposurePaths = [];
	const defaultBrowser = resolveSandboxConfigForAgent(cfg).browser;
	if (defaultBrowser.enabled && defaultBrowser.network.trim().toLowerCase() === "bridge" && !defaultBrowser.cdpSourceRange?.trim()) browserExposurePaths.push("agents.defaults.sandbox.browser");
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		const browser = resolveSandboxConfigForAgent(cfg, entry.id).browser;
		if (!browser.enabled) continue;
		if (browser.network.trim().toLowerCase() !== "bridge") continue;
		if (browser.cdpSourceRange?.trim()) continue;
		browserExposurePaths.push(`agents.list.${entry.id}.sandbox.browser`);
	}
	if (browserExposurePaths.length > 0) findings.push({
		checkId: "sandbox.browser_cdp_bridge_unrestricted",
		severity: "warn",
		title: "Sandbox browser CDP may be reachable by peer containers",
		detail: "These sandbox browser configs use Docker bridge networking with no CDP source restriction:\n" + browserExposurePaths.map((entry) => `- ${entry}`).join("\n"),
		remediation: "Set sandbox.browser.network to a dedicated bridge network (recommended default: openclaw-sandbox-browser), or set sandbox.browser.cdpSourceRange (for example 172.21.0.1/32) to restrict container-edge CDP ingress."
	});
	return findings;
}
function collectNodeDenyCommandPatternFindings(cfg) {
	const findings = [];
	const denyListRaw = cfg.gateway?.nodes?.denyCommands;
	if (!Array.isArray(denyListRaw) || denyListRaw.length === 0) return findings;
	const denyList = denyListRaw.map(normalizeNodeCommand).filter(Boolean);
	if (denyList.length === 0) return findings;
	const knownCommands = listKnownNodeCommands(cfg);
	const patternLike = denyList.filter((entry) => looksLikeNodeCommandPattern(entry));
	const unknownExact = denyList.filter((entry) => !looksLikeNodeCommandPattern(entry) && !knownCommands.has(entry));
	if (patternLike.length === 0 && unknownExact.length === 0) return findings;
	const detailParts = [];
	if (patternLike.length > 0) detailParts.push(`Pattern-like entries (not supported by exact matching): ${patternLike.join(", ")}`);
	if (unknownExact.length > 0) detailParts.push(`Unknown command names (not in defaults/allowCommands): ${unknownExact.join(", ")}`);
	const examples = Array.from(knownCommands).slice(0, 8);
	findings.push({
		checkId: "gateway.nodes.deny_commands_ineffective",
		severity: "warn",
		title: "Some gateway.nodes.denyCommands entries are ineffective",
		detail: "gateway.nodes.denyCommands uses exact node command-name matching only (for example `system.run`), not shell-text filtering inside a command payload.\n" + detailParts.map((entry) => `- ${entry}`).join("\n"),
		remediation: `Use exact command names (for example: ${examples.join(", ")}). If you need broader restrictions, remove risky command IDs from allowCommands/default workflows and tighten tools.exec policy.`
	});
	return findings;
}
function collectNodeDangerousAllowCommandFindings(cfg) {
	const findings = [];
	const allowRaw = cfg.gateway?.nodes?.allowCommands;
	if (!Array.isArray(allowRaw) || allowRaw.length === 0) return findings;
	const allow = new Set(allowRaw.map(normalizeNodeCommand).filter(Boolean));
	if (allow.size === 0) return findings;
	const deny = new Set((cfg.gateway?.nodes?.denyCommands ?? []).map(normalizeNodeCommand));
	const dangerousAllowed = DEFAULT_DANGEROUS_NODE_COMMANDS.filter((cmd) => allow.has(cmd) && !deny.has(cmd));
	if (dangerousAllowed.length === 0) return findings;
	findings.push({
		checkId: "gateway.nodes.allow_commands_dangerous",
		severity: isGatewayRemotelyExposed(cfg) ? "critical" : "warn",
		title: "Dangerous node commands explicitly enabled",
		detail: `gateway.nodes.allowCommands includes: ${dangerousAllowed.join(", ")}. These commands can trigger high-impact device actions (camera/screen/contacts/calendar/reminders/SMS).`,
		remediation: "Remove these entries from gateway.nodes.allowCommands (recommended). If you keep them, treat gateway auth as full operator access and keep gateway exposure local/tailnet-only."
	});
	return findings;
}
function collectMinimalProfileOverrideFindings(cfg) {
	const findings = [];
	if (cfg.tools?.profile !== "minimal") return findings;
	const overrides = (cfg.agents?.list ?? []).filter((entry) => {
		return Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && entry.tools?.profile && entry.tools.profile !== "minimal");
	}).map((entry) => `${entry.id}=${entry.tools?.profile}`);
	if (overrides.length === 0) return findings;
	findings.push({
		checkId: "tools.profile_minimal_overridden",
		severity: "warn",
		title: "Global tools.profile=minimal is overridden by agent profiles",
		detail: "Global minimal profile is set, but these agent profiles take precedence:\n" + overrides.map((entry) => `- agents.list.${entry}`).join("\n"),
		remediation: "Set those agents to `tools.profile=\"minimal\"` (or remove the agent override) if you want minimal tools enforced globally."
	});
	return findings;
}
function collectModelHygieneFindings(cfg) {
	const findings = [];
	const models = collectModels(cfg);
	if (models.length === 0) return findings;
	const weakMatches = /* @__PURE__ */ new Map();
	const addWeakMatch = (model, source, reason) => {
		const key = `${model}@@${source}`;
		const existing = weakMatches.get(key);
		if (!existing) {
			weakMatches.set(key, {
				model,
				source,
				reasons: [reason]
			});
			return;
		}
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
	};
	for (const entry of models) {
		for (const pat of WEAK_TIER_MODEL_PATTERNS) if (pat.re.test(entry.id)) {
			addWeakMatch(entry.id, entry.source, pat.label);
			break;
		}
		if (isGptModel(entry.id) && !isGpt5OrHigher(entry.id)) addWeakMatch(entry.id, entry.source, "Below GPT-5 family");
		if (isClaudeModel(entry.id) && !isClaude45OrHigher(entry.id)) addWeakMatch(entry.id, entry.source, "Below Claude 4.5");
	}
	const matches = [];
	for (const entry of models) for (const pat of LEGACY_MODEL_PATTERNS) if (pat.re.test(entry.id)) {
		matches.push({
			model: entry.id,
			source: entry.source,
			reason: pat.label
		});
		break;
	}
	if (matches.length > 0) {
		const lines = matches.slice(0, 12).map((m) => `- ${m.model} (${m.reason}) @ ${m.source}`).join("\n");
		const more = matches.length > 12 ? `\n…${matches.length - 12} more` : "";
		findings.push({
			checkId: "models.legacy",
			severity: "warn",
			title: "Some configured models look legacy",
			detail: "Older/legacy models can be less robust against prompt injection and tool misuse.\n" + lines + more,
			remediation: "Prefer modern, instruction-hardened models for any bot that can run tools."
		});
	}
	if (weakMatches.size > 0) {
		const lines = Array.from(weakMatches.values()).slice(0, 12).map((m) => `- ${m.model} (${m.reasons.join("; ")}) @ ${m.source}`).join("\n");
		const more = weakMatches.size > 12 ? `\n…${weakMatches.size - 12} more` : "";
		findings.push({
			checkId: "models.weak_tier",
			severity: "warn",
			title: "Some configured models are below recommended tiers",
			detail: "Smaller/older models are generally more susceptible to prompt injection and tool misuse.\n" + lines + more,
			remediation: "Use the latest, top-tier model for any bot with tools or untrusted inboxes. Avoid Haiku tiers; prefer GPT-5+ and Claude 4.5+."
		});
	}
	return findings;
}
function collectSmallModelRiskFindings(params) {
	const findings = [];
	const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
	if (models.length === 0) return findings;
	const smallModels = models.map((entry) => {
		const paramB = inferParamBFromIdOrName(entry.id);
		if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) return null;
		return {
			...entry,
			paramB
		};
	}).filter((entry) => Boolean(entry));
	if (smallModels.length === 0) return findings;
	let hasUnsafe = false;
	const modelLines = [];
	const exposureSet = /* @__PURE__ */ new Set();
	for (const entry of smallModels) {
		const agentId = extractAgentIdFromSource(entry.source);
		const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? void 0).mode;
		const agentTools = agentId && params.cfg.agents?.list ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools : void 0;
		const policies = resolveToolPolicies$1({
			cfg: params.cfg,
			agentTools,
			sandboxMode,
			agentId
		});
		const exposed = [];
		if (isWebSearchEnabled(params.cfg, params.env)) {
			if (isToolAllowedByPolicies("web_search", policies)) exposed.push("web_search");
		}
		if (isWebFetchEnabled(params.cfg)) {
			if (isToolAllowedByPolicies("web_fetch", policies)) exposed.push("web_fetch");
		}
		if (isBrowserEnabled(params.cfg)) {
			if (isToolAllowedByPolicies("browser", policies)) exposed.push("browser");
		}
		for (const tool of exposed) exposureSet.add(tool);
		const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
		const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
		const safe = sandboxMode === "all" && exposed.length === 0;
		if (!safe) hasUnsafe = true;
		const statusLabel = safe ? "ok" : "unsafe";
		modelLines.push(`- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`);
	}
	const exposureList = Array.from(exposureSet);
	const exposureDetail = exposureList.length > 0 ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.` : "No web/browser tools detected for these models.";
	findings.push({
		checkId: "models.small_params",
		severity: hasUnsafe ? "critical" : "info",
		title: "Small models require sandboxing and web tools disabled",
		detail: `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` + modelLines.join("\n") + `\n` + exposureDetail + "\nSmall models are not recommended for untrusted inputs.",
		remediation: "If you must use small models, enable sandboxing for all sessions (agents.defaults.sandbox.mode=\"all\") and disable web_search/web_fetch/browser (tools.deny=[\"group:web\",\"browser\"])."
	});
	return findings;
}
function collectExposureMatrixFindings(cfg) {
	const findings = [];
	const openGroups = listGroupPolicyOpen(cfg);
	if (openGroups.length === 0) return findings;
	if (cfg.tools?.elevated?.enabled !== false) findings.push({
		checkId: "security.exposure.open_groups_with_elevated",
		severity: "critical",
		title: "Open groupPolicy with elevated tools enabled",
		detail: `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\nWith tools.elevated enabled, a prompt injection in those rooms can become a high-impact incident.`,
		remediation: `Set groupPolicy="allowlist" and keep elevated allowlists extremely tight.`
	});
	const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
	if (riskyContexts.length > 0) findings.push({
		checkId: "security.exposure.open_groups_with_runtime_or_fs",
		severity: hasRuntimeRisk ? "critical" : "warn",
		title: "Open groupPolicy with runtime/filesystem tools exposed",
		detail: `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\nRisky tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}\nPrompt injection in open groups can trigger command/file actions in these contexts.`,
		remediation: "For open groups, prefer tools.profile=\"messaging\" (or deny group:runtime/group:fs), set tools.fs.workspaceOnly=true, and use agents.defaults.sandbox.mode=\"all\" for exposed agents."
	});
	return findings;
}
function collectLikelyMultiUserSetupFindings(cfg) {
	const findings = [];
	const signals = listPotentialMultiUserSignals(cfg);
	if (signals.length === 0) return findings;
	const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
	const impactLine = hasRuntimeRisk ? "Runtime/process tools are exposed without full sandboxing in at least one context." : "No unguarded runtime/process tools were detected by this heuristic.";
	const riskyContextsDetail = riskyContexts.length > 0 ? `Potential high-impact tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}` : "No unguarded runtime/filesystem contexts detected.";
	findings.push({
		checkId: "security.trust_model.multi_user_heuristic",
		severity: "warn",
		title: "Potential multi-user setup detected (personal-assistant model warning)",
		detail: "Heuristic signals indicate this gateway may be reachable by multiple users:\n" + signals.map((signal) => `- ${signal}`).join("\n") + `\n${impactLine}\n${riskyContextsDetail}\nOpenClaw's default security model is personal-assistant (one trusted operator boundary), not hostile multi-tenant isolation on one shared gateway.`,
		remediation: "If users may be mutually untrusted, split trust boundaries (separate gateways + credentials, ideally separate OS users/hosts). If you intentionally run shared-user access, set agents.defaults.sandbox.mode=\"all\", keep tools.fs.workspaceOnly=true, deny runtime/fs/web tools unless required, and keep personal/private identities + credentials off that runtime."
	});
	return findings;
}

//#endregion
//#region src/config/includes-scan.ts
function listDirectIncludes(parsed) {
	const out = [];
	const visit = (value) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const rec = value;
		const includeVal = rec[INCLUDE_KEY];
		if (typeof includeVal === "string") out.push(includeVal);
		else if (Array.isArray(includeVal)) {
			for (const item of includeVal) if (typeof item === "string") out.push(item);
		}
		for (const v of Object.values(rec)) visit(v);
	};
	visit(parsed);
	return out;
}
function resolveIncludePath(baseConfigPath, includePath) {
	return path.normalize(path.isAbsolute(includePath) ? includePath : path.resolve(path.dirname(baseConfigPath), includePath));
}
async function collectIncludePathsRecursive(params) {
	const visited = /* @__PURE__ */ new Set();
	const result = [];
	const walk = async (basePath, parsed, depth) => {
		if (depth > MAX_INCLUDE_DEPTH) return;
		for (const raw of listDirectIncludes(parsed)) {
			const resolved = resolveIncludePath(basePath, raw);
			if (visited.has(resolved)) continue;
			visited.add(resolved);
			result.push(resolved);
			const rawText = await fs$1.readFile(resolved, "utf-8").catch(() => null);
			if (!rawText) continue;
			const nestedParsed = (() => {
				try {
					return JSON5.parse(rawText);
				} catch {
					return null;
				}
			})();
			if (nestedParsed) await walk(resolved, nestedParsed, depth + 1);
		}
	};
	await walk(params.configPath, params.parsed, 0);
	return result;
}

//#endregion
//#region src/security/audit-extra.async.ts
/**
* Asynchronous security audit collector functions.
*
* These functions perform I/O (filesystem, config reads) to detect security issues.
*/
function expandTilde(p, env) {
	if (!p.startsWith("~")) return p;
	const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
	if (!home) return null;
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
	return null;
}
async function readPluginManifestExtensions(pluginPath) {
	const manifestPath = path.join(pluginPath, "package.json");
	const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
	if (!raw.trim()) return [];
	const extensions = JSON.parse(raw)?.[MANIFEST_KEY]?.extensions;
	if (!Array.isArray(extensions)) return [];
	return extensions.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function formatCodeSafetyDetails(findings, rootDir) {
	return findings.map((finding) => {
		const relPath = path.relative(rootDir, finding.file);
		const normalizedPath = (relPath && relPath !== "." && !relPath.startsWith("..") ? relPath : path.basename(finding.file)).replaceAll("\\", "/");
		return `  - [${finding.ruleId}] ${finding.message} (${normalizedPath}:${finding.line})`;
	}).join("\n");
}
async function listInstalledPluginDirs(params) {
	const extensionsDir = path.join(params.stateDir, "extensions");
	const st = await safeStat(extensionsDir);
	if (!st.ok || !st.isDir) return {
		extensionsDir,
		pluginDirs: []
	};
	return {
		extensionsDir,
		pluginDirs: (await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
			params.onReadError?.(err);
			return [];
		})).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter(Boolean)
	};
}
function resolveToolPolicies(params) {
	const policies = [
		resolveToolProfilePolicy(params.agentTools?.profile ?? params.cfg.tools?.profile),
		pickSandboxToolPolicy(params.cfg.tools ?? void 0),
		pickSandboxToolPolicy(params.agentTools)
	];
	if (params.sandboxMode === "all") policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? void 0));
	return policies;
}
function normalizePluginIdSet(entries) {
	return new Set(entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}
function resolveEnabledExtensionPluginIds(params) {
	const normalized = normalizePluginsConfig(params.cfg.plugins);
	if (!normalized.enabled) return [];
	const allowSet = normalizePluginIdSet(normalized.allow);
	const denySet = normalizePluginIdSet(normalized.deny);
	const entryById = /* @__PURE__ */ new Map();
	for (const [id, entry] of Object.entries(normalized.entries)) entryById.set(id.trim().toLowerCase(), entry);
	const enabled = [];
	for (const id of params.pluginDirs) {
		const normalizedId = id.trim().toLowerCase();
		if (!normalizedId) continue;
		if (denySet.has(normalizedId)) continue;
		if (allowSet.size > 0 && !allowSet.has(normalizedId)) continue;
		if (entryById.get(normalizedId)?.enabled === false) continue;
		enabled.push(normalizedId);
	}
	return enabled;
}
function collectAllowEntries(config) {
	const out = [];
	if (Array.isArray(config?.allow)) out.push(...config.allow);
	if (Array.isArray(config?.alsoAllow)) out.push(...config.alsoAllow);
	return out.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
function hasExplicitPluginAllow(params) {
	return params.allowEntries.some((entry) => entry === "group:plugins" || params.enabledPluginIds.has(entry));
}
function hasProviderPluginAllow(params) {
	if (!params.byProvider) return false;
	for (const policy of Object.values(params.byProvider)) if (hasExplicitPluginAllow({
		allowEntries: collectAllowEntries(policy),
		enabledPluginIds: params.enabledPluginIds
	})) return true;
	return false;
}
function isPinnedRegistrySpec(spec) {
	const value = spec.trim();
	if (!value) return false;
	const at = value.lastIndexOf("@");
	if (at <= 0 || at >= value.length - 1) return false;
	const version = value.slice(at + 1).trim();
	return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
async function readInstalledPackageVersion(dir) {
	try {
		const raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	}
}
function normalizeDockerLabelValue(raw) {
	const trimmed = raw?.trim() ?? "";
	if (!trimmed || trimmed === "<no value>") return null;
	return trimmed;
}
async function listSandboxBrowserContainers(execDockerRawFn) {
	try {
		const result = await execDockerRawFn([
			"ps",
			"-a",
			"--filter",
			"label=openclaw.sandboxBrowser=1",
			"--format",
			"{{.Names}}"
		], { allowFailure: true });
		if (result.code !== 0) return null;
		return result.stdout.toString("utf8").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	} catch {
		return null;
	}
}
async function readSandboxBrowserHashLabels(params) {
	try {
		const result = await params.execDockerRawFn([
			"inspect",
			"-f",
			"{{ index .Config.Labels \"openclaw.configHash\" }}	{{ index .Config.Labels \"openclaw.browserConfigEpoch\" }}",
			params.containerName
		], { allowFailure: true });
		if (result.code !== 0) return null;
		const [hashRaw, epochRaw] = result.stdout.toString("utf8").split("	");
		return {
			configHash: normalizeDockerLabelValue(hashRaw),
			epoch: normalizeDockerLabelValue(epochRaw)
		};
	} catch {
		return null;
	}
}
function parsePublishedHostFromDockerPortLine(line) {
	const trimmed = line.trim();
	const rhs = trimmed.includes("->") ? trimmed.split("->").at(-1)?.trim() ?? "" : trimmed;
	if (!rhs) return null;
	const bracketHost = rhs.match(/^\[([^\]]+)\]:\d+$/);
	if (bracketHost?.[1]) return bracketHost[1];
	const hostPort = rhs.match(/^([^:]+):\d+$/);
	if (hostPort?.[1]) return hostPort[1];
	return null;
}
function isLoopbackPublishHost(host) {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
async function readSandboxBrowserPortMappings(params) {
	try {
		const result = await params.execDockerRawFn(["port", params.containerName], { allowFailure: true });
		if (result.code !== 0) return null;
		return result.stdout.toString("utf8").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	} catch {
		return null;
	}
}
async function collectSandboxBrowserHashLabelFindings(params) {
	const findings = [];
	const execFn = params?.execDockerRawFn ?? execDockerRaw;
	const containers = await listSandboxBrowserContainers(execFn);
	if (!containers || containers.length === 0) return findings;
	const missingHash = [];
	const staleEpoch = [];
	const nonLoopbackPublished = [];
	for (const containerName of containers) {
		const labels = await readSandboxBrowserHashLabels({
			containerName,
			execDockerRawFn: execFn
		});
		if (!labels) continue;
		if (!labels.configHash) missingHash.push(containerName);
		if (labels.epoch !== SANDBOX_BROWSER_SECURITY_HASH_EPOCH) staleEpoch.push(containerName);
		const portMappings = await readSandboxBrowserPortMappings({
			containerName,
			execDockerRawFn: execFn
		});
		if (!portMappings?.length) continue;
		const exposedMappings = portMappings.filter((line) => {
			const host = parsePublishedHostFromDockerPortLine(line);
			return Boolean(host && !isLoopbackPublishHost(host));
		});
		if (exposedMappings.length > 0) nonLoopbackPublished.push(`${containerName} (${exposedMappings.join("; ")})`);
	}
	if (missingHash.length > 0) findings.push({
		checkId: "sandbox.browser_container.hash_label_missing",
		severity: "warn",
		title: "Sandbox browser container missing config hash label",
		detail: `Containers: ${missingHash.join(", ")}. These browser containers predate hash-based drift checks and may miss security remediations until recreated.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`
	});
	if (staleEpoch.length > 0) findings.push({
		checkId: "sandbox.browser_container.hash_epoch_stale",
		severity: "warn",
		title: "Sandbox browser container hash epoch is stale",
		detail: `Containers: ${staleEpoch.join(", ")}. Expected openclaw.browserConfigEpoch=${SANDBOX_BROWSER_SECURITY_HASH_EPOCH}.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`
	});
	if (nonLoopbackPublished.length > 0) findings.push({
		checkId: "sandbox.browser_container.non_loopback_publish",
		severity: "critical",
		title: "Sandbox browser container publishes ports on non-loopback interfaces",
		detail: `Containers: ${nonLoopbackPublished.join(", ")}. Sandbox browser observer/control ports should stay loopback-only to avoid unintended remote access.`,
		remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt), then verify published ports are bound to 127.0.0.1.`
	});
	return findings;
}
async function collectPluginsTrustFindings(params) {
	const findings = [];
	const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({ stateDir: params.stateDir });
	if (pluginDirs.length > 0) {
		const allow = params.cfg.plugins?.allow;
		if (!(Array.isArray(allow) && allow.length > 0)) {
			const hasString = (value) => typeof value === "string" && value.trim().length > 0;
			const hasAccountStringKey = (account, key) => Boolean(account && typeof account === "object" && hasString(account[key]));
			const discordConfigured = hasString(params.cfg.channels?.discord?.token) || Boolean(params.cfg.channels?.discord?.accounts && Object.values(params.cfg.channels.discord.accounts).some((a) => hasAccountStringKey(a, "token"))) || hasString(process.env.DISCORD_BOT_TOKEN);
			const telegramConfigured = hasString(params.cfg.channels?.telegram?.botToken) || hasString(params.cfg.channels?.telegram?.tokenFile) || Boolean(params.cfg.channels?.telegram?.accounts && Object.values(params.cfg.channels.telegram.accounts).some((a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "tokenFile"))) || hasString(process.env.TELEGRAM_BOT_TOKEN);
			const slackConfigured = hasString(params.cfg.channels?.slack?.botToken) || hasString(params.cfg.channels?.slack?.appToken) || Boolean(params.cfg.channels?.slack?.accounts && Object.values(params.cfg.channels.slack.accounts).some((a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "appToken"))) || hasString(process.env.SLACK_BOT_TOKEN) || hasString(process.env.SLACK_APP_TOKEN);
			const skillCommandsLikelyExposed = discordConfigured && resolveNativeSkillsEnabled({
				providerId: "discord",
				providerSetting: params.cfg.channels?.discord?.commands?.nativeSkills,
				globalSetting: params.cfg.commands?.nativeSkills
			}) || telegramConfigured && resolveNativeSkillsEnabled({
				providerId: "telegram",
				providerSetting: params.cfg.channels?.telegram?.commands?.nativeSkills,
				globalSetting: params.cfg.commands?.nativeSkills
			}) || slackConfigured && resolveNativeSkillsEnabled({
				providerId: "slack",
				providerSetting: params.cfg.channels?.slack?.commands?.nativeSkills,
				globalSetting: params.cfg.commands?.nativeSkills
			});
			findings.push({
				checkId: "plugins.extensions_no_allowlist",
				severity: skillCommandsLikelyExposed ? "critical" : "warn",
				title: "Extensions exist but plugins.allow is not set",
				detail: `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).` + (skillCommandsLikelyExposed ? "\nNative skill commands are enabled on at least one configured chat surface; treat unpinned/unallowlisted extensions as high risk." : ""),
				remediation: "Set plugins.allow to an explicit list of plugin ids you trust."
			});
		}
		const enabledExtensionPluginIds = resolveEnabledExtensionPluginIds({
			cfg: params.cfg,
			pluginDirs
		});
		if (enabledExtensionPluginIds.length > 0) {
			const enabledPluginSet = new Set(enabledExtensionPluginIds);
			const contexts = [{ label: "default" }];
			for (const entry of params.cfg.agents?.list ?? []) {
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
				contexts.push({
					label: `agents.list.${entry.id}`,
					agentId: entry.id,
					tools: entry.tools
				});
			}
			const permissiveContexts = [];
			for (const context of contexts) {
				const profile = context.tools?.profile ?? params.cfg.tools?.profile;
				const restrictiveProfile = Boolean(resolveToolProfilePolicy(profile));
				const sandboxMode = resolveSandboxConfigForAgent(params.cfg, context.agentId).mode;
				const broadPolicy = isToolAllowedByPolicies("__openclaw_plugin_probe__", resolveToolPolicies({
					cfg: params.cfg,
					agentTools: context.tools,
					sandboxMode,
					agentId: context.agentId
				}));
				const explicitPluginAllow = !restrictiveProfile && (hasExplicitPluginAllow({
					allowEntries: collectAllowEntries(params.cfg.tools),
					enabledPluginIds: enabledPluginSet
				}) || hasProviderPluginAllow({
					byProvider: params.cfg.tools?.byProvider,
					enabledPluginIds: enabledPluginSet
				}) || hasExplicitPluginAllow({
					allowEntries: collectAllowEntries(context.tools),
					enabledPluginIds: enabledPluginSet
				}) || hasProviderPluginAllow({
					byProvider: context.tools?.byProvider,
					enabledPluginIds: enabledPluginSet
				}));
				if (broadPolicy || explicitPluginAllow) permissiveContexts.push(context.label);
			}
			if (permissiveContexts.length > 0) findings.push({
				checkId: "plugins.tools_reachable_permissive_policy",
				severity: "warn",
				title: "Extension plugin tools may be reachable under permissive tool policy",
				detail: `Enabled extension plugins: ${enabledExtensionPluginIds.join(", ")}.\nPermissive tool policy contexts:\n${permissiveContexts.map((entry) => `- ${entry}`).join("\n")}`,
				remediation: "Use restrictive profiles (`minimal`/`coding`) or explicit tool allowlists that exclude plugin tools for agents handling untrusted input."
			});
		}
	}
	const pluginInstalls = params.cfg.plugins?.installs ?? {};
	const npmPluginInstalls = Object.entries(pluginInstalls).filter(([, record]) => record?.source === "npm");
	if (npmPluginInstalls.length > 0) {
		const unpinned = npmPluginInstalls.filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec)).map(([pluginId, record]) => `${pluginId} (${record.spec})`);
		if (unpinned.length > 0) findings.push({
			checkId: "plugins.installs_unpinned_npm_specs",
			severity: "warn",
			title: "Plugin installs include unpinned npm specs",
			detail: `Unpinned plugin install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Pin install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability."
		});
		const missingIntegrity = npmPluginInstalls.filter(([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "").map(([pluginId]) => pluginId);
		if (missingIntegrity.length > 0) findings.push({
			checkId: "plugins.installs_missing_integrity",
			severity: "warn",
			title: "Plugin installs are missing integrity metadata",
			detail: `Plugin install records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Reinstall or update plugins to refresh install metadata with resolved integrity hashes."
		});
		const pluginVersionDrift = [];
		for (const [pluginId, record] of npmPluginInstalls) {
			const recordedVersion = record.resolvedVersion ?? record.version;
			if (!recordedVersion) continue;
			const installedVersion = await readInstalledPackageVersion(record.installPath ?? path.join(params.stateDir, "extensions", pluginId));
			if (!installedVersion || installedVersion === recordedVersion) continue;
			pluginVersionDrift.push(`${pluginId} (recorded ${recordedVersion}, installed ${installedVersion})`);
		}
		if (pluginVersionDrift.length > 0) findings.push({
			checkId: "plugins.installs_version_drift",
			severity: "warn",
			title: "Plugin install records drift from installed package versions",
			detail: `Detected plugin install metadata drift:\n${pluginVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Run `openclaw plugins update --all` (or reinstall affected plugins) to refresh install metadata."
		});
	}
	const hookInstalls = params.cfg.hooks?.internal?.installs ?? {};
	const npmHookInstalls = Object.entries(hookInstalls).filter(([, record]) => record?.source === "npm");
	if (npmHookInstalls.length > 0) {
		const unpinned = npmHookInstalls.filter(([, record]) => typeof record.spec === "string" && !isPinnedRegistrySpec(record.spec)).map(([hookId, record]) => `${hookId} (${record.spec})`);
		if (unpinned.length > 0) findings.push({
			checkId: "hooks.installs_unpinned_npm_specs",
			severity: "warn",
			title: "Hook installs include unpinned npm specs",
			detail: `Unpinned hook install records:\n${unpinned.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Pin hook install specs to exact versions (for example, `@scope/pkg@1.2.3`) for higher supply-chain stability."
		});
		const missingIntegrity = npmHookInstalls.filter(([, record]) => typeof record.integrity !== "string" || record.integrity.trim() === "").map(([hookId]) => hookId);
		if (missingIntegrity.length > 0) findings.push({
			checkId: "hooks.installs_missing_integrity",
			severity: "warn",
			title: "Hook installs are missing integrity metadata",
			detail: `Hook install records missing integrity:\n${missingIntegrity.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Reinstall or update hooks to refresh install metadata with resolved integrity hashes."
		});
		const hookVersionDrift = [];
		for (const [hookId, record] of npmHookInstalls) {
			const recordedVersion = record.resolvedVersion ?? record.version;
			if (!recordedVersion) continue;
			const installedVersion = await readInstalledPackageVersion(record.installPath ?? path.join(params.stateDir, "hooks", hookId));
			if (!installedVersion || installedVersion === recordedVersion) continue;
			hookVersionDrift.push(`${hookId} (recorded ${recordedVersion}, installed ${installedVersion})`);
		}
		if (hookVersionDrift.length > 0) findings.push({
			checkId: "hooks.installs_version_drift",
			severity: "warn",
			title: "Hook install records drift from installed package versions",
			detail: `Detected hook install metadata drift:\n${hookVersionDrift.map((entry) => `- ${entry}`).join("\n")}`,
			remediation: "Run `openclaw hooks update --all` (or reinstall affected hooks) to refresh install metadata."
		});
	}
	return findings;
}
async function collectIncludeFilePermFindings(params) {
	const findings = [];
	if (!params.configSnapshot.exists) return findings;
	const configPath = params.configSnapshot.path;
	const includePaths = await collectIncludePathsRecursive({
		configPath,
		parsed: params.configSnapshot.parsed
	});
	if (includePaths.length === 0) return findings;
	for (const p of includePaths) {
		const perms = await inspectPathPermissions(p, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (!perms.ok) continue;
		if (perms.worldWritable || perms.groupWritable) findings.push({
			checkId: "fs.config_include.perms_writable",
			severity: "critical",
			title: "Config include file is writable by others",
			detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (perms.worldReadable) findings.push({
			checkId: "fs.config_include.perms_world_readable",
			severity: "critical",
			title: "Config include file is world-readable",
			detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (perms.groupReadable) findings.push({
			checkId: "fs.config_include.perms_group_readable",
			severity: "warn",
			title: "Config include file is group-readable",
			detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: p,
				perms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
	}
	return findings;
}
async function collectStateDeepFilesystemFindings(params) {
	const findings = [];
	const oauthDir = resolveOAuthDir(params.env, params.stateDir);
	const oauthPerms = await inspectPathPermissions(oauthDir, {
		env: params.env,
		platform: params.platform,
		exec: params.execIcacls
	});
	if (oauthPerms.ok && oauthPerms.isDir) {
		if (oauthPerms.worldWritable || oauthPerms.groupWritable) findings.push({
			checkId: "fs.credentials_dir.perms_writable",
			severity: "critical",
			title: "Credentials dir is writable by others",
			detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; another user could drop/modify credential files.`,
			remediation: formatPermissionRemediation({
				targetPath: oauthDir,
				perms: oauthPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
		else if (oauthPerms.groupReadable || oauthPerms.worldReadable) findings.push({
			checkId: "fs.credentials_dir.perms_readable",
			severity: "warn",
			title: "Credentials dir is readable by others",
			detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; credentials and allowlists can be sensitive.`,
			remediation: formatPermissionRemediation({
				targetPath: oauthDir,
				perms: oauthPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
	}
	const agentIds = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents?.list.map((a) => a && typeof a === "object" && typeof a.id === "string" ? a.id.trim() : "").filter(Boolean) : [];
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const ids = Array.from(new Set([defaultAgentId, ...agentIds])).map((id) => normalizeAgentId(id));
	for (const agentId of ids) {
		const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
		const authPath = path.join(agentDir, "auth-profiles.json");
		const authPerms = await inspectPathPermissions(authPath, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (authPerms.ok) {
			if (authPerms.worldWritable || authPerms.groupWritable) findings.push({
				checkId: "fs.auth_profiles.perms_writable",
				severity: "critical",
				title: "auth-profiles.json is writable by others",
				detail: `${formatPermissionDetail(authPath, authPerms)}; another user could inject credentials.`,
				remediation: formatPermissionRemediation({
					targetPath: authPath,
					perms: authPerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
			else if (authPerms.worldReadable || authPerms.groupReadable) findings.push({
				checkId: "fs.auth_profiles.perms_readable",
				severity: "warn",
				title: "auth-profiles.json is readable by others",
				detail: `${formatPermissionDetail(authPath, authPerms)}; auth-profiles.json contains API keys and OAuth tokens.`,
				remediation: formatPermissionRemediation({
					targetPath: authPath,
					perms: authPerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
		}
		const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
		const storePerms = await inspectPathPermissions(storePath, {
			env: params.env,
			platform: params.platform,
			exec: params.execIcacls
		});
		if (storePerms.ok) {
			if (storePerms.worldReadable || storePerms.groupReadable) findings.push({
				checkId: "fs.sessions_store.perms_readable",
				severity: "warn",
				title: "sessions.json is readable by others",
				detail: `${formatPermissionDetail(storePath, storePerms)}; routing and transcript metadata can be sensitive.`,
				remediation: formatPermissionRemediation({
					targetPath: storePath,
					perms: storePerms,
					isDir: false,
					posixMode: 384,
					env: params.env
				})
			});
		}
	}
	const logFile = typeof params.cfg.logging?.file === "string" ? params.cfg.logging.file.trim() : "";
	if (logFile) {
		const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
		if (expanded) {
			const logPath = path.resolve(expanded);
			const logPerms = await inspectPathPermissions(logPath, {
				env: params.env,
				platform: params.platform,
				exec: params.execIcacls
			});
			if (logPerms.ok) {
				if (logPerms.worldReadable || logPerms.groupReadable) findings.push({
					checkId: "fs.log_file.perms_readable",
					severity: "warn",
					title: "Log file is readable by others",
					detail: `${formatPermissionDetail(logPath, logPerms)}; logs can contain private messages and tool output.`,
					remediation: formatPermissionRemediation({
						targetPath: logPath,
						perms: logPerms,
						isDir: false,
						posixMode: 384,
						env: params.env
					})
				});
			}
		}
	}
	return findings;
}
async function readConfigSnapshotForAudit(params) {
	return await createConfigIO({
		env: params.env,
		configPath: params.configPath
	}).readConfigFileSnapshot();
}
async function collectPluginsCodeSafetyFindings(params) {
	const findings = [];
	const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
		stateDir: params.stateDir,
		onReadError: (err) => {
			findings.push({
				checkId: "plugins.code_safety.scan_failed",
				severity: "warn",
				title: "Plugin extensions directory scan failed",
				detail: `Static code scan could not list extensions directory: ${String(err)}`,
				remediation: "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`."
			});
		}
	});
	for (const pluginName of pluginDirs) {
		const pluginPath = path.join(extensionsDir, pluginName);
		const extensionEntries = await readPluginManifestExtensions(pluginPath).catch(() => []);
		const forcedScanEntries = [];
		const escapedEntries = [];
		for (const entry of extensionEntries) {
			const resolvedEntry = path.resolve(pluginPath, entry);
			if (!isPathInside(pluginPath, resolvedEntry)) {
				escapedEntries.push(entry);
				continue;
			}
			if (extensionUsesSkippedScannerPath(entry)) findings.push({
				checkId: "plugins.code_safety.entry_path",
				severity: "warn",
				title: `Plugin "${pluginName}" entry path is hidden or node_modules`,
				detail: `Extension entry "${entry}" points to a hidden or node_modules path. Deep code scan will cover this entry explicitly, but review this path choice carefully.`,
				remediation: "Prefer extension entrypoints under normal source paths like dist/ or src/."
			});
			forcedScanEntries.push(resolvedEntry);
		}
		if (escapedEntries.length > 0) findings.push({
			checkId: "plugins.code_safety.entry_escape",
			severity: "critical",
			title: `Plugin "${pluginName}" has extension entry path traversal`,
			detail: `Found extension entries that escape the plugin directory:\n${escapedEntries.map((entry) => `  - ${entry}`).join("\n")}`,
			remediation: "Update the plugin manifest so all openclaw.extensions entries stay inside the plugin directory."
		});
		const summary = await scanDirectoryWithSummary(pluginPath, { includeFiles: forcedScanEntries }).catch((err) => {
			findings.push({
				checkId: "plugins.code_safety.scan_failed",
				severity: "warn",
				title: `Plugin "${pluginName}" code scan failed`,
				detail: `Static code scan could not complete: ${String(err)}`,
				remediation: "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`."
			});
			return null;
		});
		if (!summary) continue;
		if (summary.critical > 0) {
			const details = formatCodeSafetyDetails(summary.findings.filter((f) => f.severity === "critical"), pluginPath);
			findings.push({
				checkId: "plugins.code_safety",
				severity: "critical",
				title: `Plugin "${pluginName}" contains dangerous code patterns`,
				detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
				remediation: "Review the plugin source code carefully before use. If untrusted, remove the plugin from your OpenClaw extensions state directory."
			});
		} else if (summary.warn > 0) {
			const details = formatCodeSafetyDetails(summary.findings.filter((f) => f.severity === "warn"), pluginPath);
			findings.push({
				checkId: "plugins.code_safety",
				severity: "warn",
				title: `Plugin "${pluginName}" contains suspicious code patterns`,
				detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
				remediation: `Review the flagged code to ensure it is intentional and safe.`
			});
		}
	}
	return findings;
}
async function collectInstalledSkillsCodeSafetyFindings(params) {
	const findings = [];
	const pluginExtensionsDir = path.join(params.stateDir, "extensions");
	const scannedSkillDirs = /* @__PURE__ */ new Set();
	const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
	for (const workspaceDir of workspaceDirs) {
		const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
		for (const entry of entries) {
			if (entry.skill.source === "openclaw-bundled") continue;
			const skillDir = path.resolve(entry.skill.baseDir);
			if (isPathInside(pluginExtensionsDir, skillDir)) continue;
			if (scannedSkillDirs.has(skillDir)) continue;
			scannedSkillDirs.add(skillDir);
			const skillName = entry.skill.name;
			const summary = await scanDirectoryWithSummary(skillDir).catch((err) => {
				findings.push({
					checkId: "skills.code_safety.scan_failed",
					severity: "warn",
					title: `Skill "${skillName}" code scan failed`,
					detail: `Static code scan could not complete for ${skillDir}: ${String(err)}`,
					remediation: "Check file permissions and skill layout, then rerun `openclaw security audit --deep`."
				});
				return null;
			});
			if (!summary) continue;
			if (summary.critical > 0) {
				const details = formatCodeSafetyDetails(summary.findings.filter((finding) => finding.severity === "critical"), skillDir);
				findings.push({
					checkId: "skills.code_safety",
					severity: "critical",
					title: `Skill "${skillName}" contains dangerous code patterns`,
					detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
					remediation: `Review the skill source code before use. If untrusted, remove "${skillDir}".`
				});
			} else if (summary.warn > 0) {
				const details = formatCodeSafetyDetails(summary.findings.filter((finding) => finding.severity === "warn"), skillDir);
				findings.push({
					checkId: "skills.code_safety",
					severity: "warn",
					title: `Skill "${skillName}" contains suspicious code patterns`,
					detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
					remediation: "Review flagged lines to ensure the behavior is intentional and safe."
				});
			}
		}
	}
	return findings;
}

//#endregion
//#region src/security/dangerous-config-flags.ts
function collectEnabledInsecureOrDangerousFlags(cfg) {
	const enabledFlags = [];
	if (cfg.gateway?.controlUi?.allowInsecureAuth === true) enabledFlags.push("gateway.controlUi.allowInsecureAuth=true");
	if (cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) enabledFlags.push("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true");
	if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) enabledFlags.push("gateway.controlUi.dangerouslyDisableDeviceAuth=true");
	if (cfg.hooks?.gmail?.allowUnsafeExternalContent === true) enabledFlags.push("hooks.gmail.allowUnsafeExternalContent=true");
	if (Array.isArray(cfg.hooks?.mappings)) {
		for (const [index, mapping] of cfg.hooks.mappings.entries()) if (mapping?.allowUnsafeExternalContent === true) enabledFlags.push(`hooks.mappings[${index}].allowUnsafeExternalContent=true`);
	}
	if (cfg.tools?.exec?.applyPatch?.workspaceOnly === false) enabledFlags.push("tools.exec.applyPatch.workspaceOnly=false");
	return enabledFlags;
}

//#endregion
//#region src/security/audit.ts
function countBySeverity(findings) {
	let critical = 0;
	let warn = 0;
	let info = 0;
	for (const f of findings) if (f.severity === "critical") critical += 1;
	else if (f.severity === "warn") warn += 1;
	else info += 1;
	return {
		critical,
		warn,
		info
	};
}
function normalizeAllowFromList(list) {
	if (!Array.isArray(list)) return [];
	return list.map((v) => String(v).trim()).filter(Boolean);
}
async function collectFilesystemFindings(params) {
	const findings = [];
	const stateDirPerms = await inspectPathPermissions(params.stateDir, {
		env: params.env,
		platform: params.platform,
		exec: params.execIcacls
	});
	if (stateDirPerms.ok) {
		if (stateDirPerms.isSymlink) findings.push({
			checkId: "fs.state_dir.symlink",
			severity: "warn",
			title: "State dir is a symlink",
			detail: `${params.stateDir} is a symlink; treat this as an extra trust boundary.`
		});
		if (stateDirPerms.worldWritable) findings.push({
			checkId: "fs.state_dir.perms_world_writable",
			severity: "critical",
			title: "State dir is world-writable",
			detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; other users can write into your OpenClaw state.`,
			remediation: formatPermissionRemediation({
				targetPath: params.stateDir,
				perms: stateDirPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
		else if (stateDirPerms.groupWritable) findings.push({
			checkId: "fs.state_dir.perms_group_writable",
			severity: "warn",
			title: "State dir is group-writable",
			detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; group users can write into your OpenClaw state.`,
			remediation: formatPermissionRemediation({
				targetPath: params.stateDir,
				perms: stateDirPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
		else if (stateDirPerms.groupReadable || stateDirPerms.worldReadable) findings.push({
			checkId: "fs.state_dir.perms_readable",
			severity: "warn",
			title: "State dir is readable by others",
			detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; consider restricting to 700.`,
			remediation: formatPermissionRemediation({
				targetPath: params.stateDir,
				perms: stateDirPerms,
				isDir: true,
				posixMode: 448,
				env: params.env
			})
		});
	}
	const configPerms = await inspectPathPermissions(params.configPath, {
		env: params.env,
		platform: params.platform,
		exec: params.execIcacls
	});
	if (configPerms.ok) {
		const skipReadablePermWarnings = configPerms.isSymlink;
		if (configPerms.isSymlink) findings.push({
			checkId: "fs.config.symlink",
			severity: "warn",
			title: "Config file is a symlink",
			detail: `${params.configPath} is a symlink; make sure you trust its target.`
		});
		if (configPerms.worldWritable || configPerms.groupWritable) findings.push({
			checkId: "fs.config.perms_writable",
			severity: "critical",
			title: "Config file is writable by others",
			detail: `${formatPermissionDetail(params.configPath, configPerms)}; another user could change gateway/auth/tool policies.`,
			remediation: formatPermissionRemediation({
				targetPath: params.configPath,
				perms: configPerms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (!skipReadablePermWarnings && configPerms.worldReadable) findings.push({
			checkId: "fs.config.perms_world_readable",
			severity: "critical",
			title: "Config file is world-readable",
			detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: params.configPath,
				perms: configPerms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
		else if (!skipReadablePermWarnings && configPerms.groupReadable) findings.push({
			checkId: "fs.config.perms_group_readable",
			severity: "warn",
			title: "Config file is group-readable",
			detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
			remediation: formatPermissionRemediation({
				targetPath: params.configPath,
				perms: configPerms,
				isDir: false,
				posixMode: 384,
				env: params.env
			})
		});
	}
	return findings;
}
function collectGatewayConfigFindings(cfg, env) {
	const findings = [];
	const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	const auth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode,
		env
	});
	const controlUiEnabled = cfg.gateway?.controlUi?.enabled !== false;
	const controlUiAllowedOrigins = (cfg.gateway?.controlUi?.allowedOrigins ?? []).map((value) => value.trim()).filter(Boolean);
	const dangerouslyAllowHostHeaderOriginFallback = cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
	const trustedProxies = Array.isArray(cfg.gateway?.trustedProxies) ? cfg.gateway.trustedProxies : [];
	const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
	const hasPassword = typeof auth.password === "string" && auth.password.trim().length > 0;
	const hasSharedSecret = auth.mode === "token" && hasToken || auth.mode === "password" && hasPassword;
	const hasTailscaleAuth = auth.allowTailscale && tailscaleMode === "serve";
	const hasGatewayAuth = hasSharedSecret || hasTailscaleAuth;
	const allowRealIpFallback = cfg.gateway?.allowRealIpFallback === true;
	const mdnsMode = cfg.discovery?.mdns?.mode ?? "minimal";
	const gatewayToolsAllowRaw = Array.isArray(cfg.gateway?.tools?.allow) ? cfg.gateway?.tools?.allow : [];
	const gatewayToolsAllow = new Set(gatewayToolsAllowRaw.map((v) => typeof v === "string" ? v.trim().toLowerCase() : "").filter(Boolean));
	const reenabledOverHttp = DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => gatewayToolsAllow.has(name));
	if (reenabledOverHttp.length > 0) {
		const extraRisk = bind !== "loopback" || tailscaleMode === "funnel";
		findings.push({
			checkId: "gateway.tools_invoke_http.dangerous_allow",
			severity: extraRisk ? "critical" : "warn",
			title: "Gateway HTTP /tools/invoke re-enables dangerous tools",
			detail: `gateway.tools.allow includes ${reenabledOverHttp.join(", ")} which removes them from the default HTTP deny list. This can allow remote session spawning / control-plane actions via HTTP and increases RCE blast radius if the gateway is reachable.`,
			remediation: "Remove these entries from gateway.tools.allow (recommended). If you keep them enabled, keep gateway.bind loopback-only (or tailnet-only), restrict network exposure, and treat the gateway token/password as full-admin."
		});
	}
	if (bind !== "loopback" && !hasSharedSecret && auth.mode !== "trusted-proxy") findings.push({
		checkId: "gateway.bind_no_auth",
		severity: "critical",
		title: "Gateway binds beyond loopback without auth",
		detail: `gateway.bind="${bind}" but no gateway.auth token/password is configured.`,
		remediation: `Set gateway.auth (token recommended) or bind to loopback.`
	});
	if (bind === "loopback" && controlUiEnabled && trustedProxies.length === 0) findings.push({
		checkId: "gateway.trusted_proxies_missing",
		severity: "warn",
		title: "Reverse proxy headers are not trusted",
		detail: "gateway.bind is loopback and gateway.trustedProxies is empty. If you expose the Control UI through a reverse proxy, configure trusted proxies so local-client checks cannot be spoofed.",
		remediation: "Set gateway.trustedProxies to your proxy IPs or keep the Control UI local-only."
	});
	if (bind === "loopback" && controlUiEnabled && !hasGatewayAuth) findings.push({
		checkId: "gateway.loopback_no_auth",
		severity: "critical",
		title: "Gateway auth missing on loopback",
		detail: "gateway.bind is loopback but no gateway auth secret is configured. If the Control UI is exposed through a reverse proxy, unauthenticated access is possible.",
		remediation: "Set gateway.auth (token recommended) or keep the Control UI local-only."
	});
	if (bind !== "loopback" && controlUiEnabled && controlUiAllowedOrigins.length === 0 && !dangerouslyAllowHostHeaderOriginFallback) findings.push({
		checkId: "gateway.control_ui.allowed_origins_required",
		severity: "critical",
		title: "Non-loopback Control UI missing explicit allowed origins",
		detail: "Control UI is enabled on a non-loopback bind but gateway.controlUi.allowedOrigins is empty. Strict origin policy requires explicit allowed origins for non-loopback deployments.",
		remediation: "Set gateway.controlUi.allowedOrigins to full trusted origins (for example https://control.example.com). If your deployment intentionally relies on Host-header origin fallback, set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true."
	});
	if (dangerouslyAllowHostHeaderOriginFallback) {
		const exposed = bind !== "loopback";
		findings.push({
			checkId: "gateway.control_ui.host_header_origin_fallback",
			severity: exposed ? "critical" : "warn",
			title: "DANGEROUS: Host-header origin fallback enabled",
			detail: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true enables Host-header origin fallback for Control UI/WebChat websocket checks and weakens DNS rebinding protections.",
			remediation: "Disable gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback and configure explicit gateway.controlUi.allowedOrigins."
		});
	}
	if (allowRealIpFallback) {
		const hasNonLoopbackTrustedProxy = trustedProxies.some((proxy) => !isStrictLoopbackTrustedProxyEntry(proxy));
		const exposed = bind !== "loopback" || auth.mode === "trusted-proxy" && hasNonLoopbackTrustedProxy;
		findings.push({
			checkId: "gateway.real_ip_fallback_enabled",
			severity: exposed ? "critical" : "warn",
			title: "X-Real-IP fallback is enabled",
			detail: "gateway.allowRealIpFallback=true trusts X-Real-IP when trusted proxies omit X-Forwarded-For. Misconfigured proxies that forward client-supplied X-Real-IP can spoof source IP and local-client checks.",
			remediation: "Keep gateway.allowRealIpFallback=false (default). Only enable this when your trusted proxy always overwrites X-Real-IP and cannot provide X-Forwarded-For."
		});
	}
	if (mdnsMode === "full") {
		const exposed = bind !== "loopback";
		findings.push({
			checkId: "discovery.mdns_full_mode",
			severity: exposed ? "critical" : "warn",
			title: "mDNS full mode can leak host metadata",
			detail: "discovery.mdns.mode=\"full\" publishes cliPath/sshPort in local-network TXT records. This can reveal usernames, filesystem layout, and management ports.",
			remediation: "Prefer discovery.mdns.mode=\"minimal\" (recommended) or \"off\", especially when gateway.bind is not loopback."
		});
	}
	if (tailscaleMode === "funnel") findings.push({
		checkId: "gateway.tailscale_funnel",
		severity: "critical",
		title: "Tailscale Funnel exposure enabled",
		detail: `gateway.tailscale.mode="funnel" exposes the Gateway publicly; keep auth strict and treat it as internet-facing.`,
		remediation: `Prefer tailscale.mode="serve" (tailnet-only) or set tailscale.mode="off".`
	});
	else if (tailscaleMode === "serve") findings.push({
		checkId: "gateway.tailscale_serve",
		severity: "info",
		title: "Tailscale Serve exposure enabled",
		detail: `gateway.tailscale.mode="serve" exposes the Gateway to your tailnet (loopback behind Tailscale).`
	});
	if (cfg.gateway?.controlUi?.allowInsecureAuth === true) findings.push({
		checkId: "gateway.control_ui.insecure_auth",
		severity: "warn",
		title: "Control UI insecure auth toggle enabled",
		detail: "gateway.controlUi.allowInsecureAuth=true does not bypass secure context or device identity checks; only dangerouslyDisableDeviceAuth disables Control UI device identity checks.",
		remediation: "Disable it or switch to HTTPS (Tailscale Serve) or localhost."
	});
	if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) findings.push({
		checkId: "gateway.control_ui.device_auth_disabled",
		severity: "critical",
		title: "DANGEROUS: Control UI device auth disabled",
		detail: "gateway.controlUi.dangerouslyDisableDeviceAuth=true disables device identity checks for the Control UI.",
		remediation: "Disable it unless you are in a short-lived break-glass scenario."
	});
	const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(cfg);
	if (enabledDangerousFlags.length > 0) findings.push({
		checkId: "config.insecure_or_dangerous_flags",
		severity: "warn",
		title: "Insecure or dangerous config flags enabled",
		detail: `Detected ${enabledDangerousFlags.length} enabled flag(s): ${enabledDangerousFlags.join(", ")}.`,
		remediation: "Disable these flags when not actively debugging, or keep deployment scoped to trusted/local-only networks."
	});
	const token = typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token.trim() : null;
	if (auth.mode === "token" && token && token.length < 24) findings.push({
		checkId: "gateway.token_too_short",
		severity: "warn",
		title: "Gateway token looks short",
		detail: `gateway auth token is ${token.length} chars; prefer a long random token.`
	});
	if (auth.mode === "trusted-proxy") {
		const trustedProxies = cfg.gateway?.trustedProxies ?? [];
		const trustedProxyConfig = cfg.gateway?.auth?.trustedProxy;
		findings.push({
			checkId: "gateway.trusted_proxy_auth",
			severity: "critical",
			title: "Trusted-proxy auth mode enabled",
			detail: "gateway.auth.mode=\"trusted-proxy\" delegates authentication to a reverse proxy. Ensure your proxy (Pomerium, Caddy, nginx) handles auth correctly and that gateway.trustedProxies only contains IPs of your actual proxy servers.",
			remediation: "Verify: (1) Your proxy terminates TLS and authenticates users. (2) gateway.trustedProxies is restricted to proxy IPs only. (3) Direct access to the Gateway port is blocked by firewall. See /gateway/trusted-proxy-auth for setup guidance."
		});
		if (trustedProxies.length === 0) findings.push({
			checkId: "gateway.trusted_proxy_no_proxies",
			severity: "critical",
			title: "Trusted-proxy auth enabled but no trusted proxies configured",
			detail: "gateway.auth.mode=\"trusted-proxy\" but gateway.trustedProxies is empty. All requests will be rejected.",
			remediation: "Set gateway.trustedProxies to the IP(s) of your reverse proxy."
		});
		if (!trustedProxyConfig?.userHeader) findings.push({
			checkId: "gateway.trusted_proxy_no_user_header",
			severity: "critical",
			title: "Trusted-proxy auth missing userHeader config",
			detail: "gateway.auth.mode=\"trusted-proxy\" but gateway.auth.trustedProxy.userHeader is not configured.",
			remediation: "Set gateway.auth.trustedProxy.userHeader to the header name your proxy uses (e.g., \"x-forwarded-user\", \"x-pomerium-claim-email\")."
		});
		if ((trustedProxyConfig?.allowUsers ?? []).length === 0) findings.push({
			checkId: "gateway.trusted_proxy_no_allowlist",
			severity: "warn",
			title: "Trusted-proxy auth allows all authenticated users",
			detail: "gateway.auth.trustedProxy.allowUsers is empty, so any user authenticated by your proxy can access the Gateway.",
			remediation: "Consider setting gateway.auth.trustedProxy.allowUsers to restrict access to specific users (e.g., [\"nick@example.com\"])."
		});
	}
	if (bind !== "loopback" && auth.mode !== "trusted-proxy" && !cfg.gateway?.auth?.rateLimit) findings.push({
		checkId: "gateway.auth_no_rate_limit",
		severity: "warn",
		title: "No auth rate limiting configured",
		detail: "gateway.bind is not loopback but no gateway.auth.rateLimit is configured. Without rate limiting, brute-force auth attacks are not mitigated.",
		remediation: "Set gateway.auth.rateLimit (e.g. { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 })."
	});
	return findings;
}
function isStrictLoopbackTrustedProxyEntry(entry) {
	const candidate = entry.trim();
	if (!candidate) return false;
	if (!candidate.includes("/")) return candidate === "127.0.0.1" || candidate.toLowerCase() === "::1";
	const [rawIp, rawPrefix] = candidate.split("/", 2);
	if (!rawIp || !rawPrefix) return false;
	const ipVersion = isIP(rawIp.trim());
	const prefix = Number.parseInt(rawPrefix.trim(), 10);
	if (!Number.isInteger(prefix)) return false;
	if (ipVersion === 4) return rawIp.trim() === "127.0.0.1" && prefix === 32;
	if (ipVersion === 6) return prefix === 128 && rawIp.trim().toLowerCase() === "::1";
	return false;
}
function collectBrowserControlFindings(cfg, env) {
	const findings = [];
	let resolved;
	try {
		resolved = resolveBrowserConfig(cfg.browser, cfg);
	} catch (err) {
		findings.push({
			checkId: "browser.control_invalid_config",
			severity: "warn",
			title: "Browser control config looks invalid",
			detail: String(err),
			remediation: `Fix browser.cdpUrl in ${resolveConfigPath()} and re-run "${formatCliCommand("openclaw security audit --deep")}".`
		});
		return findings;
	}
	if (!resolved.enabled) return findings;
	const browserAuth = resolveBrowserControlAuth(cfg, env);
	if (!browserAuth.token && !browserAuth.password) findings.push({
		checkId: "browser.control_no_auth",
		severity: "critical",
		title: "Browser control has no auth",
		detail: "Browser control HTTP routes are enabled but no gateway.auth token/password is configured. Any local process (or SSRF to loopback) can call browser control endpoints.",
		remediation: "Set gateway.auth.token (recommended) or gateway.auth.password so browser control HTTP routes require authentication. Restarting the gateway will auto-generate gateway.auth.token when browser control is enabled."
	});
	for (const name of Object.keys(resolved.profiles)) {
		const profile = resolveProfile(resolved, name);
		if (!profile || profile.cdpIsLoopback) continue;
		let url;
		try {
			url = new URL(profile.cdpUrl);
		} catch {
			continue;
		}
		if (url.protocol === "http:") findings.push({
			checkId: "browser.remote_cdp_http",
			severity: "warn",
			title: "Remote CDP uses HTTP",
			detail: `browser profile "${name}" uses http CDP (${profile.cdpUrl}); this is OK only if it's tailnet-only or behind an encrypted tunnel.`,
			remediation: `Prefer HTTPS/TLS or a tailnet-only endpoint for remote CDP.`
		});
	}
	return findings;
}
function collectLoggingFindings(cfg) {
	if (cfg.logging?.redactSensitive !== "off") return [];
	return [{
		checkId: "logging.redact_off",
		severity: "warn",
		title: "Tool summary redaction is disabled",
		detail: `logging.redactSensitive="off" can leak secrets into logs and status output.`,
		remediation: `Set logging.redactSensitive="tools".`
	}];
}
function collectElevatedFindings(cfg) {
	const findings = [];
	const enabled = cfg.tools?.elevated?.enabled;
	const allowFrom = cfg.tools?.elevated?.allowFrom ?? {};
	const anyAllowFromKeys = Object.keys(allowFrom).length > 0;
	if (enabled === false) return findings;
	if (!anyAllowFromKeys) return findings;
	for (const [provider, list] of Object.entries(allowFrom)) {
		const normalized = normalizeAllowFromList(list);
		if (normalized.includes("*")) findings.push({
			checkId: `tools.elevated.allowFrom.${provider}.wildcard`,
			severity: "critical",
			title: "Elevated exec allowlist contains wildcard",
			detail: `tools.elevated.allowFrom.${provider} includes "*" which effectively approves everyone on that channel for elevated mode.`
		});
		else if (normalized.length > 25) findings.push({
			checkId: `tools.elevated.allowFrom.${provider}.large`,
			severity: "warn",
			title: "Elevated exec allowlist is large",
			detail: `tools.elevated.allowFrom.${provider} has ${normalized.length} entries; consider tightening elevated access.`
		});
	}
	return findings;
}
function collectExecRuntimeFindings(cfg) {
	const findings = [];
	const globalExecHost = cfg.tools?.exec?.host;
	const defaultSandboxMode = resolveSandboxConfigForAgent(cfg).mode;
	if (globalExecHost === "sandbox" && defaultSandboxMode === "off") findings.push({
		checkId: "tools.exec.host_sandbox_no_sandbox_defaults",
		severity: "warn",
		title: "Exec host is sandbox but sandbox mode is off",
		detail: "tools.exec.host is explicitly set to sandbox while agents.defaults.sandbox.mode=off. In this mode, exec runs directly on the gateway host.",
		remediation: "Enable sandbox mode (`agents.defaults.sandbox.mode=\"non-main\"` or `\"all\"`) or set tools.exec.host to \"gateway\" with approvals."
	});
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const riskyAgents = agents.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.tools?.exec?.host === "sandbox" && resolveSandboxConfigForAgent(cfg, entry.id).mode === "off").map((entry) => entry.id).slice(0, 5);
	if (riskyAgents.length > 0) findings.push({
		checkId: "tools.exec.host_sandbox_no_sandbox_agents",
		severity: "warn",
		title: "Agent exec host uses sandbox while sandbox mode is off",
		detail: `agents.list.*.tools.exec.host is set to sandbox for: ${riskyAgents.join(", ")}. With sandbox mode off, exec runs directly on the gateway host.`,
		remediation: "Enable sandbox mode for these agents (`agents.list[].sandbox.mode`) or set their tools.exec.host to \"gateway\"."
	});
	const normalizeConfiguredSafeBins = (entries) => {
		if (!Array.isArray(entries)) return [];
		return Array.from(new Set(entries.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "").filter((entry) => entry.length > 0))).toSorted();
	};
	const normalizeConfiguredTrustedDirs = (entries) => {
		if (!Array.isArray(entries)) return [];
		return normalizeTrustedSafeBinDirs(entries.filter((entry) => typeof entry === "string"));
	};
	const classifyRiskySafeBinTrustedDir = (entry) => {
		const raw = entry.trim();
		if (!raw) return null;
		if (!path.isAbsolute(raw)) return "relative path (trust boundary depends on process cwd)";
		const normalized = path.resolve(raw).replace(/\\/g, "/").toLowerCase();
		if (normalized === "/tmp" || normalized.startsWith("/tmp/") || normalized === "/var/tmp" || normalized.startsWith("/var/tmp/") || normalized === "/private/tmp" || normalized.startsWith("/private/tmp/")) return "temporary directory is mutable and easy to poison";
		if (normalized === "/usr/local/bin" || normalized === "/opt/homebrew/bin" || normalized === "/opt/local/bin" || normalized === "/home/linuxbrew/.linuxbrew/bin") return "package-manager bin directory (often user-writable)";
		if (normalized.startsWith("/users/") || normalized.startsWith("/home/") || normalized.includes("/.local/bin")) return "home-scoped bin directory (typically user-writable)";
		if (/^[a-z]:\/users\//.test(normalized)) return "home-scoped bin directory (typically user-writable)";
		return null;
	};
	const globalExec = cfg.tools?.exec;
	const riskyTrustedDirHits = [];
	const collectRiskyTrustedDirHits = (scopePath, entries) => {
		for (const entry of normalizeConfiguredTrustedDirs(entries)) {
			const reason = classifyRiskySafeBinTrustedDir(entry);
			if (!reason) continue;
			riskyTrustedDirHits.push(`- ${scopePath}.safeBinTrustedDirs: ${entry} (${reason})`);
		}
	};
	collectRiskyTrustedDirHits("tools.exec", globalExec?.safeBinTrustedDirs);
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		collectRiskyTrustedDirHits(`agents.list.${entry.id}.tools.exec`, entry.tools?.exec?.safeBinTrustedDirs);
	}
	const interpreterHits = [];
	const globalSafeBins = normalizeConfiguredSafeBins(globalExec?.safeBins);
	if (globalSafeBins.length > 0) {
		const merged = resolveMergedSafeBinProfileFixtures({ global: globalExec }) ?? {};
		const interpreters = listInterpreterLikeSafeBins(globalSafeBins).filter((bin) => !merged[bin]);
		if (interpreters.length > 0) interpreterHits.push(`- tools.exec.safeBins: ${interpreters.join(", ")}`);
	}
	for (const entry of agents) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		const agentExec = entry.tools?.exec;
		const agentSafeBins = normalizeConfiguredSafeBins(agentExec?.safeBins);
		if (agentSafeBins.length === 0) continue;
		const merged = resolveMergedSafeBinProfileFixtures({
			global: globalExec,
			local: agentExec
		}) ?? {};
		const interpreters = listInterpreterLikeSafeBins(agentSafeBins).filter((bin) => !merged[bin]);
		if (interpreters.length === 0) continue;
		interpreterHits.push(`- agents.list.${entry.id}.tools.exec.safeBins: ${interpreters.join(", ")}`);
	}
	if (interpreterHits.length > 0) findings.push({
		checkId: "tools.exec.safe_bins_interpreter_unprofiled",
		severity: "warn",
		title: "safeBins includes interpreter/runtime binaries without explicit profiles",
		detail: `Detected interpreter-like safeBins entries missing explicit profiles:\n${interpreterHits.join("\n")}\nThese entries can turn safeBins into a broad execution surface when used with permissive argv profiles.`,
		remediation: "Remove interpreter/runtime bins from safeBins (prefer allowlist entries) or define hardened tools.exec.safeBinProfiles.<bin> rules."
	});
	if (riskyTrustedDirHits.length > 0) findings.push({
		checkId: "tools.exec.safe_bin_trusted_dirs_risky",
		severity: "warn",
		title: "safeBinTrustedDirs includes risky mutable directories",
		detail: `Detected risky safeBinTrustedDirs entries:\n${riskyTrustedDirHits.slice(0, 10).join("\n")}` + (riskyTrustedDirHits.length > 10 ? `\n- +${riskyTrustedDirHits.length - 10} more entries.` : ""),
		remediation: "Prefer root-owned immutable bins, keep default trust dirs (/bin, /usr/bin), and avoid trusting temporary/home/package-manager paths unless tightly controlled."
	});
	return findings;
}
async function maybeProbeGateway(params) {
	const url = buildGatewayConnectionDetails({ config: params.cfg }).url;
	const isRemoteMode = params.cfg.gateway?.mode === "remote";
	const remoteUrlRaw = typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url.trim() : "";
	const auth = !isRemoteMode || isRemoteMode && !remoteUrlRaw ? resolveGatewayProbeAuth({
		cfg: params.cfg,
		env: params.env,
		mode: "local"
	}) : resolveGatewayProbeAuth({
		cfg: params.cfg,
		env: params.env,
		mode: "remote"
	});
	const res = await params.probe({
		url,
		auth,
		timeoutMs: params.timeoutMs
	}).catch((err) => ({
		ok: false,
		url,
		connectLatencyMs: null,
		error: String(err),
		close: null,
		health: null,
		status: null,
		presence: null,
		configSnapshot: null
	}));
	return { gateway: {
		attempted: true,
		url,
		ok: res.ok,
		error: res.ok ? null : res.error,
		close: res.close ? {
			code: res.close.code,
			reason: res.close.reason
		} : null
	} };
}
async function runSecurityAudit(opts) {
	const findings = [];
	const cfg = opts.config;
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const execIcacls = opts.execIcacls;
	const stateDir = opts.stateDir ?? resolveStateDir(env);
	const configPath = opts.configPath ?? resolveConfigPath(env, stateDir);
	findings.push(...collectAttackSurfaceSummaryFindings(cfg));
	findings.push(...collectSyncedFolderFindings({
		stateDir,
		configPath
	}));
	findings.push(...collectGatewayConfigFindings(cfg, env));
	findings.push(...collectBrowserControlFindings(cfg, env));
	findings.push(...collectLoggingFindings(cfg));
	findings.push(...collectElevatedFindings(cfg));
	findings.push(...collectExecRuntimeFindings(cfg));
	findings.push(...collectHooksHardeningFindings(cfg, env));
	findings.push(...collectGatewayHttpNoAuthFindings(cfg, env));
	findings.push(...collectGatewayHttpSessionKeyOverrideFindings(cfg));
	findings.push(...collectSandboxDockerNoopFindings(cfg));
	findings.push(...collectSandboxDangerousConfigFindings(cfg));
	findings.push(...collectNodeDenyCommandPatternFindings(cfg));
	findings.push(...collectNodeDangerousAllowCommandFindings(cfg));
	findings.push(...collectMinimalProfileOverrideFindings(cfg));
	findings.push(...collectSecretsInConfigFindings(cfg));
	findings.push(...collectModelHygieneFindings(cfg));
	findings.push(...collectSmallModelRiskFindings({
		cfg,
		env
	}));
	findings.push(...collectExposureMatrixFindings(cfg));
	findings.push(...collectLikelyMultiUserSetupFindings(cfg));
	const configSnapshot = opts.includeFilesystem !== false ? await readConfigSnapshotForAudit({
		env,
		configPath
	}).catch(() => null) : null;
	if (opts.includeFilesystem !== false) {
		findings.push(...await collectFilesystemFindings({
			stateDir,
			configPath,
			env,
			platform,
			execIcacls
		}));
		if (configSnapshot) findings.push(...await collectIncludeFilePermFindings({
			configSnapshot,
			env,
			platform,
			execIcacls
		}));
		findings.push(...await collectStateDeepFilesystemFindings({
			cfg,
			env,
			stateDir,
			platform,
			execIcacls
		}));
		findings.push(...await collectSandboxBrowserHashLabelFindings({ execDockerRawFn: opts.execDockerRawFn }));
		findings.push(...await collectPluginsTrustFindings({
			cfg,
			stateDir
		}));
		if (opts.deep === true) {
			findings.push(...await collectPluginsCodeSafetyFindings({ stateDir }));
			findings.push(...await collectInstalledSkillsCodeSafetyFindings({
				cfg,
				stateDir
			}));
		}
	}
	if (opts.includeChannelSecurity !== false) {
		const plugins = opts.plugins ?? listChannelPlugins();
		findings.push(...await collectChannelSecurityFindings({
			cfg,
			plugins
		}));
	}
	const deep = opts.deep === true ? await maybeProbeGateway({
		cfg,
		env,
		timeoutMs: Math.max(250, opts.deepTimeoutMs ?? 5e3),
		probe: opts.probeGatewayFn ?? probeGateway
	}) : void 0;
	if (deep?.gateway?.attempted && !deep.gateway.ok) findings.push({
		checkId: "gateway.probe_failed",
		severity: "warn",
		title: "Gateway probe failed (deep)",
		detail: deep.gateway.error ?? "gateway unreachable",
		remediation: `Run "${formatCliCommand("openclaw status --all")}" to debug connectivity/auth, then re-run "${formatCliCommand("openclaw security audit --deep")}".`
	});
	const summary = countBySeverity(findings);
	return {
		ts: Date.now(),
		summary,
		findings,
		deep
	};
}

//#endregion
export { isNodeCommandAllowed as a, resolveGatewayProbeAuth as i, collectEnabledInsecureOrDangerousFlags as n, resolveNodeCommandAllowlist as o, collectIncludePathsRecursive as r, probeGateway as s, runSecurityAudit as t };