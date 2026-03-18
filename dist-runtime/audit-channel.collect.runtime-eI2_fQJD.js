import "./redact-qojvLPM7.js";
import { r as formatErrorMessage } from "./errors-nCFRNLA6.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./utils-BiUV1eIQ.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { U as resolveChannelDefaultAccountId, x as inspectReadOnlyChannelAccount } from "./plugins-DC9n978g.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
import { a as resolveNativeSkillsEnabled, i as resolveNativeCommandsEnabled } from "./commands-BfMCtxuV.js";
import { n as hasResolvedCredentialValue, t as hasConfiguredUnavailableCredentialStatus } from "./account-snapshot-fields-B_ffWpeH.js";
import { r as resolveDmAllowState } from "./dm-policy-shared-QWD8iFx0.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-qouO4mvQ.js";
//#region src/security/audit-channel.ts
let auditChannelRuntimeModulePromise;
function loadAuditChannelRuntimeModule() {
	auditChannelRuntimeModulePromise ??= import("./audit-channel.runtime-CSPAcyrv.js");
	return auditChannelRuntimeModulePromise;
}
function normalizeAllowFromList(list) {
	return normalizeStringEntries(Array.isArray(list) ? list : void 0);
}
function addDiscordNameBasedEntries(params) {
	if (!Array.isArray(params.values)) return;
	for (const value of params.values) {
		if (!params.isDiscordMutableAllowEntry(String(value))) continue;
		const text = String(value).trim();
		if (!text) continue;
		params.target.add(`${params.source}:${text}`);
	}
}
function addZalouserMutableGroupEntries(params) {
	if (!params.groups || typeof params.groups !== "object" || Array.isArray(params.groups)) return;
	for (const key of Object.keys(params.groups)) {
		if (!params.isZalouserMutableGroupEntry(key)) continue;
		params.target.add(`${params.source}:${key}`);
	}
}
async function collectInvalidTelegramAllowFromEntries(params) {
	if (!Array.isArray(params.entries)) return;
	const { isNumericTelegramUserId, normalizeTelegramAllowFromEntry } = await loadAuditChannelRuntimeModule();
	for (const entry of params.entries) {
		const normalized = normalizeTelegramAllowFromEntry(entry);
		if (!normalized || normalized === "*") continue;
		if (!isNumericTelegramUserId(normalized)) params.target.add(normalized);
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
	return Object.hasOwn(accounts, accountId);
}
async function collectChannelSecurityFindings(params) {
	const findings = [];
	const sourceConfig = params.sourceConfig ?? params.cfg;
	const inspectChannelAccount = async (plugin, cfg, accountId) => plugin.config.inspectAccount?.(cfg, accountId) ?? await inspectReadOnlyChannelAccount({
		channelId: plugin.id,
		cfg,
		accountId
	});
	const asAccountRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
	const resolveChannelAuditAccount = async (plugin, accountId) => {
		const diagnostics = [];
		const sourceInspectedAccount = await inspectChannelAccount(plugin, sourceConfig, accountId);
		const resolvedInspectedAccount = await inspectChannelAccount(plugin, params.cfg, accountId);
		const sourceInspection = sourceInspectedAccount;
		const resolvedInspection = resolvedInspectedAccount;
		let resolvedAccount = resolvedInspectedAccount;
		if (!resolvedAccount) try {
			resolvedAccount = plugin.config.resolveAccount(params.cfg, accountId);
		} catch (error) {
			diagnostics.push(`${plugin.id}:${accountId}: failed to resolve account (${formatErrorMessage(error)}).`);
		}
		if (!resolvedAccount && sourceInspectedAccount) resolvedAccount = sourceInspectedAccount;
		if (!resolvedAccount) return {
			account: {},
			enabled: false,
			configured: false,
			diagnostics
		};
		const useSourceUnavailableAccount = Boolean(sourceInspectedAccount && hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) && (!hasResolvedCredentialValue(resolvedAccount) || sourceInspection?.configured === true && resolvedInspection?.configured === false));
		const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
		const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
		const accountRecord = asAccountRecord(account);
		let enabled = typeof selectedInspection?.enabled === "boolean" ? selectedInspection.enabled : typeof accountRecord?.enabled === "boolean" ? accountRecord.enabled : true;
		if (typeof selectedInspection?.enabled !== "boolean" && typeof accountRecord?.enabled !== "boolean" && plugin.config.isEnabled) try {
			enabled = plugin.config.isEnabled(account, params.cfg);
		} catch (error) {
			enabled = false;
			diagnostics.push(`${plugin.id}:${accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`);
		}
		let configured = typeof selectedInspection?.configured === "boolean" ? selectedInspection.configured : typeof accountRecord?.configured === "boolean" ? accountRecord.configured : true;
		if (typeof selectedInspection?.configured !== "boolean" && typeof accountRecord?.configured !== "boolean" && plugin.config.isConfigured) try {
			configured = await plugin.config.isConfigured(account, params.cfg);
		} catch (error) {
			configured = false;
			diagnostics.push(`${plugin.id}:${accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`);
		}
		return {
			account,
			enabled,
			configured,
			diagnostics
		};
	};
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
		const accountIds = plugin.config.listAccountIds(sourceConfig);
		const defaultAccountId = resolveChannelDefaultAccountId({
			plugin,
			cfg: sourceConfig,
			accountIds
		});
		const orderedAccountIds = Array.from(new Set([defaultAccountId, ...accountIds]));
		for (const accountId of orderedAccountIds) {
			const hasExplicitAccountPath = hasExplicitProviderAccountConfig(sourceConfig, plugin.id, accountId);
			const { account, enabled, configured, diagnostics } = await resolveChannelAuditAccount(plugin, accountId);
			for (const diagnostic of diagnostics) findings.push({
				checkId: `channels.${plugin.id}.account.read_only_resolution`,
				severity: "warn",
				title: `${plugin.meta.label ?? plugin.id} account could not be fully resolved`,
				detail: diagnostic,
				remediation: "Ensure referenced secrets are available in this shell or run with a running gateway snapshot so security audit can inspect the full channel configuration."
			});
			if (!enabled) continue;
			if (!configured) continue;
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
				const { isDiscordMutableAllowEntry, readChannelAllowFromStore } = await loadAuditChannelRuntimeModule();
				const discordCfg = account?.config ?? {};
				const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(discordCfg);
				const storeAllowFrom = await readChannelAllowFromStore("discord", process.env, accountId).catch(() => []);
				const discordNameBasedAllowEntries = /* @__PURE__ */ new Set();
				const discordPathPrefix = orderedAccountIds.length > 1 || hasExplicitAccountPath ? `channels.discord.accounts.${accountId}` : "channels.discord";
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: discordCfg.allowFrom,
					source: `${discordPathPrefix}.allowFrom`,
					isDiscordMutableAllowEntry
				});
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: discordCfg.dm?.allowFrom,
					source: `${discordPathPrefix}.dm.allowFrom`,
					isDiscordMutableAllowEntry
				});
				addDiscordNameBasedEntries({
					target: discordNameBasedAllowEntries,
					values: storeAllowFrom,
					source: "~/.openclaw/credentials/discord-allowFrom.json",
					isDiscordMutableAllowEntry
				});
				const discordGuildEntries = discordCfg.guilds ?? {};
				for (const [guildKey, guildValue] of Object.entries(discordGuildEntries)) {
					if (!guildValue || typeof guildValue !== "object") continue;
					const guild = guildValue;
					addDiscordNameBasedEntries({
						target: discordNameBasedAllowEntries,
						values: guild.users,
						source: `${discordPathPrefix}.guilds.${guildKey}.users`,
						isDiscordMutableAllowEntry
					});
					const channels = guild.channels;
					if (!channels || typeof channels !== "object") continue;
					for (const [channelKey, channelValue] of Object.entries(channels)) {
						if (!channelValue || typeof channelValue !== "object") continue;
						addDiscordNameBasedEntries({
							target: discordNameBasedAllowEntries,
							values: channelValue.users,
							source: `${discordPathPrefix}.guilds.${guildKey}.channels.${channelKey}.users`,
							isDiscordMutableAllowEntry
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
					const ownerAllowFromConfigured = normalizeAllowFromList([...Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [], ...storeAllowFrom]).length > 0;
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
			if (plugin.id === "zalouser") {
				const { isZalouserMutableGroupEntry } = await loadAuditChannelRuntimeModule();
				const zalouserCfg = account?.config ?? {};
				const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(zalouserCfg);
				const zalouserPathPrefix = orderedAccountIds.length > 1 || hasExplicitAccountPath ? `channels.zalouser.accounts.${accountId}` : "channels.zalouser";
				const mutableGroupEntries = /* @__PURE__ */ new Set();
				addZalouserMutableGroupEntries({
					target: mutableGroupEntries,
					groups: zalouserCfg.groups,
					source: `${zalouserPathPrefix}.groups`,
					isZalouserMutableGroupEntry
				});
				if (mutableGroupEntries.size > 0) {
					const examples = Array.from(mutableGroupEntries).slice(0, 5);
					const more = mutableGroupEntries.size > examples.length ? ` (+${mutableGroupEntries.size - examples.length} more)` : "";
					findings.push({
						checkId: "channels.zalouser.groups.mutable_entries",
						severity: dangerousNameMatchingEnabled ? "info" : "warn",
						title: dangerousNameMatchingEnabled ? "Zalouser group routing uses break-glass name matching" : "Zalouser group routing contains mutable group entries",
						detail: dangerousNameMatchingEnabled ? `Zalouser group-name routing is explicitly enabled via dangerouslyAllowNameMatching. This mutable-identity mode is operator-selected break-glass behavior and out-of-scope for vulnerability reports by itself. Found: ${examples.join(", ")}${more}.` : `Zalouser group auth is ID-only by default, so unresolved group-name or slug entries are ignored for auth and can drift from the intended trusted group. Found: ${examples.join(", ")}${more}.`,
						remediation: dangerousNameMatchingEnabled ? "Prefer stable Zalo group IDs (for example group:<id> or provider-native g- ids), then disable dangerouslyAllowNameMatching." : "Prefer stable Zalo group IDs in channels.zalouser.groups, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept mutable group-name matching."
					});
				}
			}
			if (plugin.id === "slack") {
				const { readChannelAllowFromStore } = await loadAuditChannelRuntimeModule();
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
					const ownerAllowFromConfigured = normalizeAllowFromList([...allowFrom, ...storeAllowFrom]).length > 0;
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
			const { readChannelAllowFromStore } = await loadAuditChannelRuntimeModule();
			const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
			const storeHasWildcard = storeAllowFrom.some((v) => String(v).trim() === "*");
			const invalidTelegramAllowFromEntries = /* @__PURE__ */ new Set();
			await collectInvalidTelegramAllowFromEntries({
				entries: storeAllowFrom,
				target: invalidTelegramAllowFromEntries
			});
			const groupAllowFrom = Array.isArray(telegramCfg.groupAllowFrom) ? telegramCfg.groupAllowFrom : [];
			const groupAllowFromHasWildcard = groupAllowFrom.some((v) => String(v).trim() === "*");
			await collectInvalidTelegramAllowFromEntries({
				entries: groupAllowFrom,
				target: invalidTelegramAllowFromEntries
			});
			await collectInvalidTelegramAllowFromEntries({
				entries: Array.isArray(telegramCfg.allowFrom) ? telegramCfg.allowFrom : [],
				target: invalidTelegramAllowFromEntries
			});
			let anyGroupOverride = false;
			if (groups) for (const value of Object.values(groups)) {
				if (!value || typeof value !== "object") continue;
				const group = value;
				const allowFrom = Array.isArray(group.allowFrom) ? group.allowFrom : [];
				if (allowFrom.length > 0) {
					anyGroupOverride = true;
					await collectInvalidTelegramAllowFromEntries({
						entries: allowFrom,
						target: invalidTelegramAllowFromEntries
					});
				}
				const topics = group.topics;
				if (!topics || typeof topics !== "object") continue;
				for (const topicValue of Object.values(topics)) {
					if (!topicValue || typeof topicValue !== "object") continue;
					const topic = topicValue;
					const topicAllow = Array.isArray(topic.allowFrom) ? topic.allowFrom : [];
					if (topicAllow.length > 0) anyGroupOverride = true;
					await collectInvalidTelegramAllowFromEntries({
						entries: topicAllow,
						target: invalidTelegramAllowFromEntries
					});
				}
			}
			const hasAnySenderAllowlist = storeAllowFrom.length > 0 || groupAllowFrom.length > 0 || anyGroupOverride;
			if (invalidTelegramAllowFromEntries.size > 0) {
				const examples = Array.from(invalidTelegramAllowFromEntries).slice(0, 5);
				const more = invalidTelegramAllowFromEntries.size > examples.length ? ` (+${invalidTelegramAllowFromEntries.size - examples.length} more)` : "";
				findings.push({
					checkId: "channels.telegram.allowFrom.invalid_entries",
					severity: "warn",
					title: "Telegram allowlist contains non-numeric entries",
					detail: `Telegram sender authorization requires numeric Telegram user IDs. Found non-numeric allowFrom entries: ${examples.join(", ")}${more}.`,
					remediation: "Replace @username entries with numeric Telegram user IDs (use setup to resolve), then re-run the audit."
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
export { collectChannelSecurityFindings };
