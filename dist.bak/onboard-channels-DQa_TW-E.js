import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { E as formatChannelSelectionLine, O as listChatChannels, T as formatChannelPrimerLine, W as CONFIG_DIR, nt as normalizeE164, rt as pathExists, s as createSubsystemLogger } from "./entry.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { h as normalizeAccountId, m as DEFAULT_ACCOUNT_ID } from "./session-key-qmb11-mH.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { C as resolveDiscordAccount, S as resolveDefaultDiscordAccountId, b as listDiscordAccountIds, d as resolveTelegramAccount, h as resolveSlackAccount, l as listTelegramAccountIds, m as resolveDefaultSlackAccountId, n as listChannelPlugins, p as listSlackAccountIds, t as getChannelPlugin, u as resolveDefaultTelegramAccountId } from "./plugins-BOmV0yTv.js";
import { a as resolveWhatsAppAuthDir, n as listWhatsAppAccountIds, r as resolveDefaultWhatsAppAccountId } from "./accounts-jTTYYc3C.js";
import { n as resolveDefaultIMessageAccountId, r as resolveIMessageAccount, t as listIMessageAccountIds } from "./accounts-CnxuiQaw.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId } from "./accounts-DKgW2m_s.js";
import { dt as normalizeDiscordSlug } from "./send-E2dqyGVy.js";
import { Ln as resolveSlackUserAllowlist, Rn as resolveDiscordUserAllowlist, T as resolveDiscordChannelAllowlist, _ as loadOpenClawPlugins, g as createPluginLoaderLogger, y as resolveSlackChannelAllowlist } from "./subagent-registry-BrzwRDvR.js";
import { a as listChannelPluginCatalogEntries, n as isChannelConfigured } from "./plugin-auto-enable-CP9tjqOm.js";
import { s as normalizeIMessageHandle } from "./send-DoyQYD6v.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { r as detectBinary } from "./onboard-helpers-CijgoJ1t.js";
import { t as loginWeb } from "./login-B7DOJpPV.js";
import { t as resolveBrewExecutable } from "./brew-Dn6VHYfr.js";
import { n as moveSingleAccountChannelSectionToDefaultAccount, t as fetchTelegramChatId } from "./api-DaLeB0gD.js";
import { t as resolveChannelDefaultAccountId } from "./helpers-BgzIw8DX.js";
import { t as enablePluginInConfig } from "./enable-DcrehKxk.js";
import { a as extractArchive } from "./install-safe-path-CtKGJTZO.js";
import { n as recordPluginInstall, r as installPluginFromNpmSpec, t as buildNpmResolutionInstallFields } from "./installs-5RpMCv1U.js";
import os from "node:os";
import path from "node:path";
import fs, { createWriteStream } from "node:fs";
import fs$1 from "node:fs/promises";
import { request } from "node:https";
import { pipeline } from "node:stream/promises";

//#region src/commands/onboarding/plugin-install.ts
function hasGitWorkspace(workspaceDir) {
	const candidates = /* @__PURE__ */ new Set();
	candidates.add(path.join(process.cwd(), ".git"));
	if (workspaceDir && workspaceDir !== process.cwd()) candidates.add(path.join(workspaceDir, ".git"));
	for (const candidate of candidates) if (fs.existsSync(candidate)) return true;
	return false;
}
function resolveLocalPath(entry, workspaceDir, allowLocal) {
	if (!allowLocal) return null;
	const raw = entry.install.localPath?.trim();
	if (!raw) return null;
	const candidates = /* @__PURE__ */ new Set();
	candidates.add(path.resolve(process.cwd(), raw));
	if (workspaceDir && workspaceDir !== process.cwd()) candidates.add(path.resolve(workspaceDir, raw));
	for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
	return null;
}
function addPluginLoadPath(cfg, pluginPath) {
	const existing = cfg.plugins?.load?.paths ?? [];
	const merged = Array.from(new Set([...existing, pluginPath]));
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			load: {
				...cfg.plugins?.load,
				paths: merged
			}
		}
	};
}
async function promptInstallChoice(params) {
	const { entry, localPath, prompter, defaultChoice } = params;
	const localOptions = localPath ? [{
		value: "local",
		label: "Use local plugin path",
		hint: localPath
	}] : [];
	const options = [
		{
			value: "npm",
			label: `Download from npm (${entry.install.npmSpec})`
		},
		...localOptions,
		{
			value: "skip",
			label: "Skip for now"
		}
	];
	const initialValue = defaultChoice === "local" && !localPath ? "npm" : defaultChoice;
	return await prompter.select({
		message: `Install ${entry.meta.label} plugin?`,
		options,
		initialValue
	});
}
function resolveInstallDefaultChoice(params) {
	const { cfg, entry, localPath } = params;
	const updateChannel = cfg.update?.channel;
	if (updateChannel === "dev") return localPath ? "local" : "npm";
	if (updateChannel === "stable" || updateChannel === "beta") return "npm";
	const entryDefault = entry.install.defaultChoice;
	if (entryDefault === "local") return localPath ? "local" : "npm";
	if (entryDefault === "npm") return "npm";
	return localPath ? "local" : "npm";
}
async function ensureOnboardingPluginInstalled(params) {
	const { entry, prompter, runtime, workspaceDir } = params;
	let next = params.cfg;
	const localPath = resolveLocalPath(entry, workspaceDir, hasGitWorkspace(workspaceDir));
	const choice = await promptInstallChoice({
		entry,
		localPath,
		defaultChoice: resolveInstallDefaultChoice({
			cfg: next,
			entry,
			localPath
		}),
		prompter
	});
	if (choice === "skip") return {
		cfg: next,
		installed: false
	};
	if (choice === "local" && localPath) {
		next = addPluginLoadPath(next, localPath);
		next = enablePluginInConfig(next, entry.id).config;
		return {
			cfg: next,
			installed: true
		};
	}
	const result = await installPluginFromNpmSpec({
		spec: entry.install.npmSpec,
		logger: {
			info: (msg) => runtime.log?.(msg),
			warn: (msg) => runtime.log?.(msg)
		}
	});
	if (result.ok) {
		next = enablePluginInConfig(next, result.pluginId).config;
		next = recordPluginInstall(next, {
			pluginId: result.pluginId,
			source: "npm",
			spec: entry.install.npmSpec,
			installPath: result.targetDir,
			version: result.version,
			...buildNpmResolutionInstallFields(result.npmResolution)
		});
		return {
			cfg: next,
			installed: true
		};
	}
	await prompter.note(`Failed to install ${entry.install.npmSpec}: ${result.error}`, "Plugin install");
	if (localPath) {
		if (await prompter.confirm({
			message: `Use local plugin path instead? (${localPath})`,
			initialValue: true
		})) {
			next = addPluginLoadPath(next, localPath);
			next = enablePluginInConfig(next, entry.id).config;
			return {
				cfg: next,
				installed: true
			};
		}
	}
	runtime.error?.(`Plugin install failed: ${result.error}`);
	return {
		cfg: next,
		installed: false
	};
}
function reloadOnboardingPluginRegistry(params) {
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
	const log = createSubsystemLogger("plugins");
	loadOpenClawPlugins({
		config: params.cfg,
		workspaceDir,
		cache: false,
		logger: createPluginLoaderLogger(log)
	});
}

//#endregion
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id
		})), {
			value: "__new__",
			label: "Add a new account"
		}],
		initialValue: initial
	});
	if (choice !== "__new__") return normalizeAccountId(choice);
	const entered = await params.prompter.text({
		message: `New ${params.label} account id`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const normalized = normalizeAccountId(String(entered));
	if (String(entered).trim() !== normalized) await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
	return normalized;
}

//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
const promptAccountId = async (params) => {
	return await promptAccountId$1(params);
};
function addWildcardAllowFrom(allowFrom) {
	const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
	if (!next.includes("*")) next.push("*");
	return next;
}
function mergeAllowFromEntries(current, additions) {
	const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
	return [...new Set(merged)];
}
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function parseOnboardingEntriesWithParser(raw, parseEntry) {
	const parts = splitOnboardingEntries(String(raw ?? ""));
	const entries = [];
	for (const part of parts) {
		const parsed = parseEntry(part);
		if ("error" in parsed) return {
			entries: [],
			error: parsed.error
		};
		entries.push(parsed.value);
	}
	return { entries: normalizeAllowFromEntries(entries) };
}
function parseOnboardingEntriesAllowingWildcard(raw, parseEntry) {
	return parseOnboardingEntriesWithParser(raw, (entry) => {
		if (entry === "*") return { value: "*" };
		return parseEntry(entry);
	});
}
function parseMentionOrPrefixedId(params) {
	const trimmed = params.value.trim();
	if (!trimmed) return null;
	const mentionMatch = trimmed.match(params.mentionPattern);
	if (mentionMatch?.[1]) return params.normalizeId ? params.normalizeId(mentionMatch[1]) : mentionMatch[1];
	const stripped = params.prefixPattern ? trimmed.replace(params.prefixPattern, "") : trimmed;
	if (!params.idPattern.test(stripped)) return null;
	return params.normalizeId ? params.normalizeId(stripped) : stripped;
}
function normalizeAllowFromEntries(entries, normalizeEntry) {
	const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
		if (entry === "*") return "*";
		if (!normalizeEntry) return entry;
		const value = normalizeEntry(entry);
		return typeof value === "string" ? value.trim() : "";
	}).filter(Boolean);
	return [...new Set(normalized)];
}
function resolveOnboardingAccountId(params) {
	return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
}
async function resolveAccountIdForConfigure(params) {
	const override = params.accountOverride?.trim();
	let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
	if (params.shouldPromptAccountIds && !override) accountId = await promptAccountId({
		cfg: params.cfg,
		prompter: params.prompter,
		label: params.label,
		currentId: accountId,
		listAccountIds: params.listAccountIds,
		defaultAccountId: params.defaultAccountId
	});
	return accountId;
}
function setAccountAllowFromForChannel(params) {
	const { cfg, channel, accountId, allowFrom } = params;
	return patchConfigForScopedAccount({
		cfg,
		channel,
		accountId,
		patch: { allowFrom },
		ensureEnabled: false
	});
}
function setChannelDmPolicyWithAllowFrom(params) {
	const { cfg, channel, dmPolicy } = params;
	const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...cfg.channels?.[channel],
				dmPolicy,
				...allowFrom ? { allowFrom } : {}
			}
		}
	};
}
function setLegacyChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {
		allowFrom: void 0,
		dm: void 0
	};
	const existingAllowFrom = channelConfig.allowFrom ?? channelConfig.dm?.allowFrom;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function setLegacyChannelAllowFrom(params) {
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: { allowFrom: params.allowFrom }
	});
}
function setAccountGroupPolicyForChannel(params) {
	return patchChannelConfigForAccount({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		patch: { groupPolicy: params.groupPolicy }
	});
}
function patchLegacyDmChannelConfig(params) {
	const { cfg, channel, patch } = params;
	const channelConfig = cfg.channels?.[channel] ?? {};
	const dmConfig = channelConfig.dm ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				...patch,
				dm: {
					...dmConfig,
					enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true
				}
			}
		}
	};
}
function setOnboardingChannelEnabled(cfg, channel, enabled) {
	const channelConfig = cfg.channels?.[channel] ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				enabled
			}
		}
	};
}
function patchConfigForScopedAccount(params) {
	const { cfg, channel, accountId, patch, ensureEnabled } = params;
	const seededCfg = accountId === DEFAULT_ACCOUNT_ID ? cfg : moveSingleAccountChannelSectionToDefaultAccount({
		cfg,
		channelKey: channel
	});
	const channelConfig = seededCfg.channels?.[channel] ?? {};
	if (accountId === DEFAULT_ACCOUNT_ID) return {
		...seededCfg,
		channels: {
			...seededCfg.channels,
			[channel]: {
				...channelConfig,
				...ensureEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = channelConfig.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...seededCfg,
		channels: {
			...seededCfg.channels,
			[channel]: {
				...channelConfig,
				...ensureEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...patch
					}
				}
			}
		}
	};
}
function patchChannelConfigForAccount(params) {
	return patchConfigForScopedAccount({
		...params,
		ensureEnabled: true
	});
}
function applySingleTokenPromptResult(params) {
	let next = params.cfg;
	if (params.tokenResult.useEnv) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: {}
	});
	if (params.tokenResult.token) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: { [params.tokenPatchKey]: params.tokenResult.token }
	});
	return next;
}
async function promptSingleChannelToken(params) {
	const promptToken = async () => String(await params.prompter.text({
		message: params.inputPrompt,
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
	if (params.canUseEnv) {
		if (await params.prompter.confirm({
			message: params.envPrompt,
			initialValue: true
		})) return {
			useEnv: true,
			token: null
		};
		return {
			useEnv: false,
			token: await promptToken()
		};
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return {
			useEnv: false,
			token: null
		};
	}
	return {
		useEnv: false,
		token: await promptToken()
	};
}
async function promptParsedAllowFromForScopedChannel(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: params.defaultAccountId
	});
	const existing = params.getExistingAllowFrom({
		cfg: params.cfg,
		accountId
	});
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const entry = await params.prompter.text({
		message: params.message,
		placeholder: params.placeholder,
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			return params.parseEntries(raw).error;
		}
	});
	const unique = mergeAllowFromEntries(void 0, params.parseEntries(String(entry)).entries);
	return setAccountAllowFromForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId,
		allowFrom: unique
	});
}
async function noteChannelLookupSummary(params) {
	const lines = [];
	for (const section of params.resolvedSections) {
		if (section.values.length === 0) continue;
		lines.push(`${section.title}: ${section.values.join(", ")}`);
	}
	if (params.unresolved && params.unresolved.length > 0) lines.push(`Unresolved (kept as typed): ${params.unresolved.join(", ")}`);
	if (lines.length > 0) await params.prompter.note(lines.join("\n"), params.label);
}
async function noteChannelLookupFailure(params) {
	await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${String(params.error)}`, params.label);
}
async function promptResolvedAllowFrom(params) {
	while (true) {
		const entry = await params.prompter.text({
			message: params.message,
			placeholder: params.placeholder,
			initialValue: params.existing[0] ? String(params.existing[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = params.parseInputs(String(entry));
		if (!params.token) {
			const ids = parts.map(params.parseId).filter(Boolean);
			if (ids.length !== parts.length) {
				await params.prompter.note(params.invalidWithoutTokenNote, params.label);
				continue;
			}
			return mergeAllowFromEntries(params.existing, ids);
		}
		const results = await params.resolveEntries({
			token: params.token,
			entries: parts
		}).catch(() => null);
		if (!results) {
			await params.prompter.note("Failed to resolve usernames. Try again.", params.label);
			continue;
		}
		const unresolved = results.filter((res) => !res.resolved || !res.id);
		if (unresolved.length > 0) {
			await params.prompter.note(`Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`, params.label);
			continue;
		}
		const ids = results.map((res) => res.id);
		return mergeAllowFromEntries(params.existing, ids);
	}
}
async function promptLegacyChannelAllowFrom(params) {
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const unique = await promptResolvedAllowFrom({
		prompter: params.prompter,
		existing: params.existing,
		token: params.token,
		message: params.message,
		placeholder: params.placeholder,
		label: params.noteTitle,
		parseInputs: splitOnboardingEntries,
		parseId: params.parseId,
		invalidWithoutTokenNote: params.invalidWithoutTokenNote,
		resolveEntries: params.resolveEntries
	});
	return setLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: params.channel,
		allowFrom: unique
	});
}

//#endregion
//#region src/channels/plugins/onboarding/channel-access.ts
function parseAllowlistEntries(raw) {
	return splitOnboardingEntries(String(raw ?? ""));
}
function formatAllowlistEntries(entries) {
	return entries.map((entry) => entry.trim()).filter(Boolean).join(", ");
}
async function promptChannelAccessPolicy(params) {
	const options = [{
		value: "allowlist",
		label: "Allowlist (recommended)"
	}];
	if (params.allowOpen !== false) options.push({
		value: "open",
		label: "Open (allow all channels)"
	});
	if (params.allowDisabled !== false) options.push({
		value: "disabled",
		label: "Disabled (block all channels)"
	});
	const initialValue = params.currentPolicy ?? "allowlist";
	return await params.prompter.select({
		message: `${params.label} access`,
		options,
		initialValue
	});
}
async function promptChannelAllowlist(params) {
	const initialValue = params.currentEntries && params.currentEntries.length > 0 ? formatAllowlistEntries(params.currentEntries) : void 0;
	return parseAllowlistEntries(await params.prompter.text({
		message: `${params.label} allowlist (comma-separated)`,
		placeholder: params.placeholder,
		initialValue
	}));
}
async function promptChannelAccessConfig(params) {
	const hasEntries = (params.currentEntries ?? []).length > 0;
	const shouldPrompt = params.defaultPrompt ?? !hasEntries;
	if (!await params.prompter.confirm({
		message: params.updatePrompt ? `Update ${params.label} access?` : `Configure ${params.label} access?`,
		initialValue: shouldPrompt
	})) return null;
	const policy = await promptChannelAccessPolicy({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		allowOpen: params.allowOpen,
		allowDisabled: params.allowDisabled
	});
	if (policy !== "allowlist") return {
		policy,
		entries: []
	};
	return {
		policy,
		entries: await promptChannelAllowlist({
			prompter: params.prompter,
			label: params.label,
			currentEntries: params.currentEntries,
			placeholder: params.placeholder
		})
	};
}

//#endregion
//#region src/channels/plugins/onboarding/channel-access-configure.ts
async function configureChannelAccessWithAllowlist(params) {
	let next = params.cfg;
	const accessConfig = await promptChannelAccessConfig({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		currentEntries: params.currentEntries,
		placeholder: params.placeholder,
		updatePrompt: params.updatePrompt
	});
	if (!accessConfig) return next;
	if (accessConfig.policy !== "allowlist") return params.setPolicy(next, accessConfig.policy);
	const resolved = await params.resolveAllowlist({
		cfg: next,
		entries: accessConfig.entries
	});
	next = params.setPolicy(next, "allowlist");
	return params.applyAllowlist({
		cfg: next,
		resolved
	});
}

//#endregion
//#region src/channels/plugins/onboarding/discord.ts
const channel$5 = "discord";
async function noteDiscordTokenHelp(prompter) {
	await prompter.note([
		"1) Discord Developer Portal → Applications → New Application",
		"2) Bot → Add Bot → Reset Token → copy token",
		"3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
		"Tip: enable Message Content Intent if you need message text. (Bot → Privileged Gateway Intents → Message Content Intent)",
		`Docs: ${formatDocsLink("/discord", "discord")}`
	].join("\n"), "Discord bot token");
}
function setDiscordGuildChannelAllowlist(cfg, accountId, entries) {
	const guilds = { ...accountId === DEFAULT_ACCOUNT_ID ? cfg.channels?.discord?.guilds ?? {} : cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {} };
	for (const entry of entries) {
		const guildKey = entry.guildKey || "*";
		const existing = guilds[guildKey] ?? {};
		if (entry.channelKey) {
			const channels = { ...existing.channels };
			channels[entry.channelKey] = { allow: true };
			guilds[guildKey] = {
				...existing,
				channels
			};
		} else guilds[guildKey] = existing;
	}
	return patchChannelConfigForAccount({
		cfg,
		channel: "discord",
		accountId,
		patch: { guilds }
	});
}
async function promptDiscordAllowFrom(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultDiscordAccountId(params.cfg)
	});
	const token = resolveDiscordAccount({
		cfg: params.cfg,
		accountId
	}).token;
	const existing = params.cfg.channels?.discord?.allowFrom ?? params.cfg.channels?.discord?.dm?.allowFrom ?? [];
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixPattern: /^(user:|discord:)/i,
		idPattern: /^\d+$/
	});
	return promptLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: "discord",
		prompter: params.prompter,
		existing,
		token,
		noteTitle: "Discord allowlist",
		noteLines: [
			"Allowlist Discord DMs by username (we resolve to user ids).",
			"Examples:",
			"- 123456789012345678",
			"- @alice",
			"- alice#1234",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/discord", "discord")}`
		],
		message: "Discord allowFrom (usernames or ids)",
		placeholder: "@alice, 123456789012345678",
		parseId,
		invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
		resolveEntries: ({ token, entries }) => resolveDiscordUserAllowlist({
			token,
			entries
		})
	});
}
const dmPolicy$4 = {
	label: "Discord",
	channel: channel$5,
	policyKey: "channels.discord.dmPolicy",
	allowFromKey: "channels.discord.allowFrom",
	getCurrent: (cfg) => cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
	setPolicy: (cfg, policy) => setLegacyChannelDmPolicyWithAllowFrom({
		cfg,
		channel: "discord",
		dmPolicy: policy
	}),
	promptAllowFrom: promptDiscordAllowFrom
};
const discordOnboardingAdapter = {
	channel: channel$5,
	getStatus: async ({ cfg }) => {
		const configured = listDiscordAccountIds(cfg).some((accountId) => Boolean(resolveDiscordAccount({
			cfg,
			accountId
		}).token));
		return {
			channel: channel$5,
			configured,
			statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
			selectionHint: configured ? "configured" : "needs token",
			quickstartScore: configured ? 2 : 1
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
		const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
		const discordAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Discord",
			accountOverride: accountOverrides.discord,
			shouldPromptAccountIds,
			listAccountIds: listDiscordAccountIds,
			defaultAccountId: defaultDiscordAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveDiscordAccount({
			cfg: next,
			accountId: discordAccountId
		});
		const accountConfigured = Boolean(resolvedAccount.token);
		const canUseEnv = discordAccountId === DEFAULT_ACCOUNT_ID && !resolvedAccount.config.token && Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
		const hasConfigToken = Boolean(resolvedAccount.config.token);
		if (!accountConfigured) await noteDiscordTokenHelp(prompter);
		const tokenResult = await promptSingleChannelToken({
			prompter,
			accountConfigured,
			canUseEnv,
			hasConfigToken,
			envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Discord token already configured. Keep it?",
			inputPrompt: "Enter Discord bot token"
		});
		next = applySingleTokenPromptResult({
			cfg: next,
			channel: "discord",
			accountId: discordAccountId,
			tokenPatchKey: "token",
			tokenResult
		});
		const currentEntries = Object.entries(resolvedAccount.config.guilds ?? {}).flatMap(([guildKey, value]) => {
			const channels = value?.channels ?? {};
			const channelKeys = Object.keys(channels);
			if (channelKeys.length === 0) return [/^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey];
			return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
		});
		next = await configureChannelAccessWithAllowlist({
			cfg: next,
			prompter,
			label: "Discord channels",
			currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
			currentEntries,
			placeholder: "My Server/#general, guildId/channelId, #support",
			updatePrompt: Boolean(resolvedAccount.config.guilds),
			setPolicy: (cfg, policy) => setAccountGroupPolicyForChannel({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				groupPolicy: policy
			}),
			resolveAllowlist: async ({ cfg, entries }) => {
				const accountWithTokens = resolveDiscordAccount({
					cfg,
					accountId: discordAccountId
				});
				let resolved = entries.map((input) => ({
					input,
					resolved: false
				}));
				if (accountWithTokens.token && entries.length > 0) try {
					resolved = await resolveDiscordChannelAllowlist({
						token: accountWithTokens.token,
						entries
					});
					const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
					const resolvedGuilds = resolved.filter((entry) => entry.resolved && entry.guildId && !entry.channelId);
					const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
					await noteChannelLookupSummary({
						prompter,
						label: "Discord channels",
						resolvedSections: [{
							title: "Resolved channels",
							values: resolvedChannels.map((entry) => entry.channelId).filter((value) => Boolean(value))
						}, {
							title: "Resolved guilds",
							values: resolvedGuilds.map((entry) => entry.guildId).filter((value) => Boolean(value))
						}],
						unresolved
					});
				} catch (err) {
					await noteChannelLookupFailure({
						prompter,
						label: "Discord channels",
						error: err
					});
				}
				return resolved;
			},
			applyAllowlist: ({ cfg, resolved }) => {
				const allowlistEntries = [];
				for (const entry of resolved) {
					const guildKey = entry.guildId ?? (entry.guildName ? normalizeDiscordSlug(entry.guildName) : void 0) ?? "*";
					const channelKey = entry.channelId ?? (entry.channelName ? normalizeDiscordSlug(entry.channelName) : void 0);
					if (!channelKey && guildKey === "*") continue;
					allowlistEntries.push({
						guildKey,
						...channelKey ? { channelKey } : {}
					});
				}
				return setDiscordGuildChannelAllowlist(cfg, discordAccountId, allowlistEntries);
			}
		});
		return {
			cfg: next,
			accountId: discordAccountId
		};
	},
	dmPolicy: dmPolicy$4,
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$5, false)
};

//#endregion
//#region src/channels/plugins/onboarding/imessage.ts
const channel$4 = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		const lower = entry.toLowerCase();
		if (lower.startsWith("chat_id:")) {
			const id = entry.slice(8).trim();
			if (!/^\d+$/.test(id)) return { error: `Invalid chat_id: ${entry}` };
			return { value: entry };
		}
		if (lower.startsWith("chat_guid:")) {
			if (!entry.slice(10).trim()) return { error: "Invalid chat_guid entry" };
			return { value: entry };
		}
		if (lower.startsWith("chat_identifier:")) {
			if (!entry.slice(16).trim()) return { error: "Invalid chat_identifier entry" };
			return { value: entry };
		}
		if (!normalizeIMessageHandle(entry)) return { error: `Invalid handle: ${entry}` };
		return { value: entry };
	});
}
async function promptIMessageAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "iMessage allowlist",
		noteLines: [
			"Allowlist iMessage DMs by handle or chat target.",
			"Examples:",
			"- +15555550123",
			"- user@example.com",
			"- chat_id:123",
			"- chat_guid:... or chat_identifier:...",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		],
		message: "iMessage allowFrom (handle or chat_id)",
		placeholder: "+15555550123, user@example.com, chat_id:123",
		parseEntries: parseIMessageAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveIMessageAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const dmPolicy$3 = {
	label: "iMessage",
	channel: channel$4,
	policyKey: "channels.imessage.dmPolicy",
	allowFromKey: "channels.imessage.allowFrom",
	getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
		cfg,
		channel: "imessage",
		dmPolicy: policy
	}),
	promptAllowFrom: promptIMessageAllowFrom
};
const imessageOnboardingAdapter = {
	channel: channel$4,
	getStatus: async ({ cfg }) => {
		const configured = listIMessageAccountIds(cfg).some((accountId) => {
			const account = resolveIMessageAccount({
				cfg,
				accountId
			});
			return Boolean(account.config.cliPath || account.config.dbPath || account.config.allowFrom || account.config.service || account.config.region);
		});
		const imessageCliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
		const imessageCliDetected = await detectBinary(imessageCliPath);
		return {
			channel: channel$4,
			configured,
			statusLines: [`iMessage: ${configured ? "configured" : "needs setup"}`, `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`],
			selectionHint: imessageCliDetected ? "imsg found" : "imsg missing",
			quickstartScore: imessageCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
		const defaultIMessageAccountId = resolveDefaultIMessageAccountId(cfg);
		const imessageAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "iMessage",
			accountOverride: accountOverrides.imessage,
			shouldPromptAccountIds,
			listAccountIds: listIMessageAccountIds,
			defaultAccountId: defaultIMessageAccountId
		});
		let next = cfg;
		let resolvedCliPath = resolveIMessageAccount({
			cfg: next,
			accountId: imessageAccountId
		}).config.cliPath ?? "imsg";
		if (!await detectBinary(resolvedCliPath)) {
			const entered = await prompter.text({
				message: "imsg CLI path",
				initialValue: resolvedCliPath,
				validate: (value) => value?.trim() ? void 0 : "Required"
			});
			resolvedCliPath = String(entered).trim();
			if (!resolvedCliPath) await prompter.note("imsg CLI path required to enable iMessage.", "iMessage");
		}
		if (resolvedCliPath) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "imessage",
			accountId: imessageAccountId,
			patch: { cliPath: resolvedCliPath }
		});
		await prompter.note([
			"This is still a work in progress.",
			"Ensure OpenClaw has Full Disk Access to Messages DB.",
			"Grant Automation permission for Messages when prompted.",
			"List chats with: imsg chats --limit 20",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		].join("\n"), "iMessage next steps");
		return {
			cfg: next,
			accountId: imessageAccountId
		};
	},
	dmPolicy: dmPolicy$3,
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$4, false)
};

//#endregion
//#region src/commands/signal-install.ts
/** @internal Exported for testing. */
async function extractSignalCliArchive(archivePath, installRoot, timeoutMs) {
	await extractArchive({
		archivePath,
		destDir: installRoot,
		timeoutMs
	});
}
/** @internal Exported for testing. */
function looksLikeArchive(name) {
	return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}
/**
* Pick a native release asset from the official GitHub releases.
*
* The official signal-cli releases only publish native (GraalVM) binaries for
* x86-64 Linux.  On architectures where no native asset is available this
* returns `undefined` so the caller can fall back to a different install
* strategy (e.g. Homebrew).
*/
/** @internal Exported for testing. */
function pickAsset(assets, platform, arch) {
	const archives = assets.filter((asset) => Boolean(asset.name && asset.browser_download_url)).filter((a) => looksLikeArchive(a.name.toLowerCase()));
	const byName = (pattern) => archives.find((asset) => pattern.test(asset.name.toLowerCase()));
	if (platform === "linux") {
		if (arch === "x64") return byName(/linux-native/) || byName(/linux/) || archives[0];
		return;
	}
	if (platform === "darwin") return byName(/macos|osx|darwin/) || archives[0];
	if (platform === "win32") return byName(/windows|win/) || archives[0];
	return archives[0];
}
async function downloadToFile(url, dest, maxRedirects = 5) {
	await new Promise((resolve, reject) => {
		const req = request(url, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
				const location = res.headers.location;
				if (!location || maxRedirects <= 0) {
					reject(/* @__PURE__ */ new Error("Redirect loop or missing Location header"));
					return;
				}
				const redirectUrl = new URL(location, url).href;
				resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
				return;
			}
			if (!res.statusCode || res.statusCode >= 400) {
				reject(/* @__PURE__ */ new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
				return;
			}
			pipeline(res, createWriteStream(dest)).then(resolve).catch(reject);
		});
		req.on("error", reject);
		req.end();
	});
}
async function findSignalCliBinary(root) {
	const candidates = [];
	const enqueue = async (dir, depth) => {
		if (depth > 3) return;
		const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await enqueue(full, depth + 1);
			else if (entry.isFile() && entry.name === "signal-cli") candidates.push(full);
		}
	};
	await enqueue(root, 0);
	return candidates[0] ?? null;
}
async function resolveBrewSignalCliPath(brewExe) {
	try {
		const result = await runCommandWithTimeout([
			brewExe,
			"--prefix",
			"signal-cli"
		], { timeoutMs: 1e4 });
		if (result.code === 0 && result.stdout.trim()) {
			const prefix = result.stdout.trim();
			const candidate = path.join(prefix, "bin", "signal-cli");
			try {
				await fs$1.access(candidate);
				return candidate;
			} catch {
				return findSignalCliBinary(prefix);
			}
		}
	} catch {}
	return null;
}
async function installSignalCliViaBrew(runtime) {
	const brewExe = resolveBrewExecutable();
	if (!brewExe) return {
		ok: false,
		error: `No native signal-cli build is available for ${process.arch}. Install Homebrew (https://brew.sh) and try again, or install signal-cli manually.`
	};
	runtime.log(`Installing signal-cli via Homebrew (${brewExe})…`);
	const result = await runCommandWithTimeout([
		brewExe,
		"install",
		"signal-cli"
	], { timeoutMs: 15 * 6e4 });
	if (result.code !== 0) return {
		ok: false,
		error: `brew install signal-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`
	};
	const cliPath = await resolveBrewSignalCliPath(brewExe);
	if (!cliPath) return {
		ok: false,
		error: "brew install succeeded but signal-cli binary was not found."
	};
	let version;
	try {
		version = (await runCommandWithTimeout([cliPath, "--version"], { timeoutMs: 1e4 })).stdout.trim().replace(/^signal-cli\s+/, "") || void 0;
	} catch {}
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCliFromRelease(runtime) {
	const response = await fetch("https://api.github.com/repos/AsamK/signal-cli/releases/latest", { headers: {
		"User-Agent": "openclaw",
		Accept: "application/vnd.github+json"
	} });
	if (!response.ok) return {
		ok: false,
		error: `Failed to fetch release info (${response.status})`
	};
	const payload = await response.json();
	const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
	const asset = pickAsset(payload.assets ?? [], process.platform, process.arch);
	if (!asset) return {
		ok: false,
		error: "No compatible release asset found for this platform."
	};
	const tmpDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-"));
	const archivePath = path.join(tmpDir, asset.name);
	runtime.log(`Downloading signal-cli ${version} (${asset.name})…`);
	await downloadToFile(asset.browser_download_url, archivePath);
	const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
	await fs$1.mkdir(installRoot, { recursive: true });
	if (!looksLikeArchive(asset.name.toLowerCase())) return {
		ok: false,
		error: `Unsupported archive type: ${asset.name}`
	};
	try {
		await extractSignalCliArchive(archivePath, installRoot, 6e4);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Failed to extract ${asset.name}: ${message}`
		};
	}
	const cliPath = await findSignalCliBinary(installRoot);
	if (!cliPath) return {
		ok: false,
		error: `signal-cli binary not found after extracting ${asset.name}`
	};
	await fs$1.chmod(cliPath, 493).catch(() => {});
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCli(runtime) {
	if (process.platform === "win32") return {
		ok: false,
		error: "Signal CLI auto-install is not supported on Windows yet."
	};
	if (process.platform !== "linux" || process.arch === "x64") return installSignalCliFromRelease(runtime);
	return installSignalCliViaBrew(runtime);
}

//#endregion
//#region src/channels/plugins/onboarding/signal.ts
const channel$3 = "signal";
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR = "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
function normalizeSignalAccountInput(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const digits = normalizeE164(trimmed).slice(1);
	if (!DIGITS_ONLY.test(digits)) return null;
	if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
	return `+${digits}`;
}
function isUuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function parseSignalAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		if (entry.toLowerCase().startsWith("uuid:")) {
			const id = entry.slice(5).trim();
			if (!id) return { error: "Invalid uuid entry" };
			return { value: `uuid:${id}` };
		}
		if (isUuidLike(entry)) return { value: `uuid:${entry}` };
		const normalized = normalizeSignalAccountInput(entry);
		if (!normalized) return { error: `Invalid entry: ${entry}` };
		return { value: normalized };
	});
}
async function promptSignalAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "signal",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "Signal allowlist",
		noteLines: [
			"Allowlist Signal DMs by sender id.",
			"Examples:",
			"- +15555550123",
			"- uuid:123e4567-e89b-12d3-a456-426614174000",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/signal", "signal")}`
		],
		message: "Signal allowFrom (E.164 or uuid)",
		placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
		parseEntries: parseSignalAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveSignalAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const dmPolicy$2 = {
	label: "Signal",
	channel: channel$3,
	policyKey: "channels.signal.dmPolicy",
	allowFromKey: "channels.signal.allowFrom",
	getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
		cfg,
		channel: "signal",
		dmPolicy: policy
	}),
	promptAllowFrom: promptSignalAllowFrom
};
const signalOnboardingAdapter = {
	channel: channel$3,
	getStatus: async ({ cfg }) => {
		const configured = listSignalAccountIds(cfg).some((accountId) => resolveSignalAccount({
			cfg,
			accountId
		}).configured);
		const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
		const signalCliDetected = await detectBinary(signalCliPath);
		return {
			channel: channel$3,
			configured,
			statusLines: [`Signal: ${configured ? "configured" : "needs setup"}`, `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`],
			selectionHint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
			quickstartScore: signalCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, runtime, prompter, accountOverrides, shouldPromptAccountIds, options }) => {
		const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
		const signalAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Signal",
			accountOverride: accountOverrides.signal,
			shouldPromptAccountIds,
			listAccountIds: listSignalAccountIds,
			defaultAccountId: defaultSignalAccountId
		});
		let next = cfg;
		const accountConfig = resolveSignalAccount({
			cfg: next,
			accountId: signalAccountId
		}).config;
		let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
		let cliDetected = await detectBinary(resolvedCliPath);
		if (options?.allowSignalInstall) {
			if (await prompter.confirm({
				message: cliDetected ? "signal-cli detected. Reinstall/update now?" : "signal-cli not found. Install now?",
				initialValue: !cliDetected
			})) try {
				const result = await installSignalCli(runtime);
				if (result.ok && result.cliPath) {
					cliDetected = true;
					resolvedCliPath = result.cliPath;
					await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
				} else if (!result.ok) await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
			} catch (err) {
				await prompter.note(`signal-cli install failed: ${String(err)}`, "Signal");
			}
		}
		if (!cliDetected) await prompter.note("signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.", "Signal");
		let account = accountConfig.account ?? "";
		if (account) {
			const normalizedExisting = normalizeSignalAccountInput(account);
			if (!normalizedExisting) {
				await prompter.note("Existing Signal account isn't a valid E.164 number. Please enter it again.", "Signal");
				account = "";
			} else {
				account = normalizedExisting;
				if (!await prompter.confirm({
					message: `Signal account set (${account}). Keep it?`,
					initialValue: true
				})) account = "";
			}
		}
		if (!account) account = normalizeSignalAccountInput(String(await prompter.text({
			message: "Signal bot number (E.164)",
			validate: (value) => normalizeSignalAccountInput(String(value ?? "")) ? void 0 : INVALID_SIGNAL_ACCOUNT_ERROR
		}))) ?? "";
		if (account) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "signal",
			accountId: signalAccountId,
			patch: {
				account,
				cliPath: resolvedCliPath ?? "signal-cli"
			}
		});
		await prompter.note([
			"Link device with: signal-cli link -n \"OpenClaw\"",
			"Scan QR in Signal → Linked Devices",
			`Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
			`Docs: ${formatDocsLink("/signal", "signal")}`
		].join("\n"), "Signal next steps");
		return {
			cfg: next,
			accountId: signalAccountId
		};
	},
	dmPolicy: dmPolicy$2,
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$3, false)
};

//#endregion
//#region src/channels/plugins/onboarding/slack.ts
const channel$2 = "slack";
function buildSlackManifest(botName) {
	const safeName = botName.trim() || "OpenClaw";
	const manifest = {
		display_information: {
			name: safeName,
			description: `${safeName} connector for OpenClaw`
		},
		features: {
			bot_user: {
				display_name: safeName,
				always_online: false
			},
			app_home: {
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false
			},
			slash_commands: [{
				command: "/openclaw",
				description: "Send a message to OpenClaw",
				should_escape: false
			}]
		},
		oauth_config: { scopes: { bot: [
			"chat:write",
			"channels:history",
			"channels:read",
			"groups:history",
			"im:history",
			"mpim:history",
			"users:read",
			"app_mentions:read",
			"reactions:read",
			"reactions:write",
			"pins:read",
			"pins:write",
			"emoji:read",
			"commands",
			"files:read",
			"files:write"
		] } },
		settings: {
			socket_mode_enabled: true,
			event_subscriptions: { bot_events: [
				"app_mention",
				"message.channels",
				"message.groups",
				"message.im",
				"message.mpim",
				"reaction_added",
				"reaction_removed",
				"member_joined_channel",
				"member_left_channel",
				"channel_rename",
				"pin_added",
				"pin_removed"
			] }
		}
	};
	return JSON.stringify(manifest, null, 2);
}
async function noteSlackTokenHelp(prompter, botName) {
	const manifest = buildSlackManifest(botName);
	await prompter.note([
		"1) Slack API → Create App → From scratch",
		"2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
		"3) OAuth & Permissions → install app to workspace (xoxb- bot token)",
		"4) Enable Event Subscriptions (socket) for message events",
		"5) App Home → enable the Messages tab for DMs",
		"Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
		`Docs: ${formatDocsLink("/slack", "slack")}`,
		"",
		"Manifest (JSON):",
		manifest
	].join("\n"), "Slack socket mode tokens");
}
async function promptSlackTokens(prompter) {
	return {
		botToken: String(await prompter.text({
			message: "Enter Slack bot token (xoxb-...)",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		appToken: String(await prompter.text({
			message: "Enter Slack app token (xapp-...)",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim()
	};
}
function setSlackChannelAllowlist(cfg, accountId, channelKeys) {
	return patchChannelConfigForAccount({
		cfg,
		channel: "slack",
		accountId,
		patch: { channels: Object.fromEntries(channelKeys.map((key) => [key, { allow: true }])) }
	});
}
async function promptSlackAllowFrom(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSlackAccountId(params.cfg)
	});
	const resolved = resolveSlackAccount({
		cfg: params.cfg,
		accountId
	});
	const token = resolved.config.userToken ?? resolved.config.botToken ?? "";
	const existing = params.cfg.channels?.slack?.allowFrom ?? params.cfg.channels?.slack?.dm?.allowFrom ?? [];
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@([A-Z0-9]+)>$/i,
		prefixPattern: /^(slack:|user:)/i,
		idPattern: /^[A-Z][A-Z0-9]+$/i,
		normalizeId: (id) => id.toUpperCase()
	});
	return promptLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: "slack",
		prompter: params.prompter,
		existing,
		token,
		noteTitle: "Slack allowlist",
		noteLines: [
			"Allowlist Slack DMs by username (we resolve to user ids).",
			"Examples:",
			"- U12345678",
			"- @alice",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/slack", "slack")}`
		],
		message: "Slack allowFrom (usernames or ids)",
		placeholder: "@alice, U12345678",
		parseId,
		invalidWithoutTokenNote: "Slack token missing; use user ids (or mention form) only.",
		resolveEntries: ({ token, entries }) => resolveSlackUserAllowlist({
			token,
			entries
		})
	});
}
const dmPolicy$1 = {
	label: "Slack",
	channel: channel$2,
	policyKey: "channels.slack.dmPolicy",
	allowFromKey: "channels.slack.allowFrom",
	getCurrent: (cfg) => cfg.channels?.slack?.dmPolicy ?? cfg.channels?.slack?.dm?.policy ?? "pairing",
	setPolicy: (cfg, policy) => setLegacyChannelDmPolicyWithAllowFrom({
		cfg,
		channel: "slack",
		dmPolicy: policy
	}),
	promptAllowFrom: promptSlackAllowFrom
};
const slackOnboardingAdapter = {
	channel: channel$2,
	getStatus: async ({ cfg }) => {
		const configured = listSlackAccountIds(cfg).some((accountId) => {
			const account = resolveSlackAccount({
				cfg,
				accountId
			});
			return Boolean(account.botToken && account.appToken);
		});
		return {
			channel: channel$2,
			configured,
			statusLines: [`Slack: ${configured ? "configured" : "needs tokens"}`],
			selectionHint: configured ? "configured" : "needs tokens",
			quickstartScore: configured ? 2 : 1
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
		const defaultSlackAccountId = resolveDefaultSlackAccountId(cfg);
		const slackAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Slack",
			accountOverride: accountOverrides.slack,
			shouldPromptAccountIds,
			listAccountIds: listSlackAccountIds,
			defaultAccountId: defaultSlackAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveSlackAccount({
			cfg: next,
			accountId: slackAccountId
		});
		const accountConfigured = Boolean(resolvedAccount.botToken && resolvedAccount.appToken);
		const canUseEnv = slackAccountId === DEFAULT_ACCOUNT_ID && Boolean(process.env.SLACK_BOT_TOKEN?.trim()) && Boolean(process.env.SLACK_APP_TOKEN?.trim());
		const hasConfigTokens = Boolean(resolvedAccount.config.botToken && resolvedAccount.config.appToken);
		let botToken = null;
		let appToken = null;
		const slackBotName = String(await prompter.text({
			message: "Slack bot display name (used for manifest)",
			initialValue: "OpenClaw"
		})).trim();
		if (!accountConfigured) await noteSlackTokenHelp(prompter, slackBotName);
		if (canUseEnv && (!resolvedAccount.config.botToken || !resolvedAccount.config.appToken)) if (await prompter.confirm({
			message: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
			initialValue: true
		})) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "slack",
			accountId: slackAccountId,
			patch: {}
		});
		else ({botToken, appToken} = await promptSlackTokens(prompter));
		else if (hasConfigTokens) {
			if (!await prompter.confirm({
				message: "Slack tokens already configured. Keep them?",
				initialValue: true
			})) ({botToken, appToken} = await promptSlackTokens(prompter));
		} else ({botToken, appToken} = await promptSlackTokens(prompter));
		if (botToken && appToken) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "slack",
			accountId: slackAccountId,
			patch: {
				botToken,
				appToken
			}
		});
		next = await configureChannelAccessWithAllowlist({
			cfg: next,
			prompter,
			label: "Slack channels",
			currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
			currentEntries: Object.entries(resolvedAccount.config.channels ?? {}).filter(([, value]) => value?.allow !== false && value?.enabled !== false).map(([key]) => key),
			placeholder: "#general, #private, C123",
			updatePrompt: Boolean(resolvedAccount.config.channels),
			setPolicy: (cfg, policy) => setAccountGroupPolicyForChannel({
				cfg,
				channel: "slack",
				accountId: slackAccountId,
				groupPolicy: policy
			}),
			resolveAllowlist: async ({ cfg, entries }) => {
				let keys = entries;
				const accountWithTokens = resolveSlackAccount({
					cfg,
					accountId: slackAccountId
				});
				if (accountWithTokens.botToken && entries.length > 0) try {
					const resolved = await resolveSlackChannelAllowlist({
						token: accountWithTokens.botToken,
						entries
					});
					const resolvedKeys = resolved.filter((entry) => entry.resolved && entry.id).map((entry) => entry.id);
					const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
					keys = [...resolvedKeys, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
					await noteChannelLookupSummary({
						prompter,
						label: "Slack channels",
						resolvedSections: [{
							title: "Resolved",
							values: resolvedKeys
						}],
						unresolved
					});
				} catch (err) {
					await noteChannelLookupFailure({
						prompter,
						label: "Slack channels",
						error: err
					});
				}
				return keys;
			},
			applyAllowlist: ({ cfg, resolved }) => {
				return setSlackChannelAllowlist(cfg, slackAccountId, resolved);
			}
		});
		return {
			cfg: next,
			accountId: slackAccountId
		};
	},
	dmPolicy: dmPolicy$1,
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$2, false)
};

//#endregion
//#region src/channels/plugins/onboarding/telegram.ts
const channel$1 = "telegram";
async function noteTelegramTokenHelp(prompter) {
	await prompter.note([
		"1) Open Telegram and chat with @BotFather",
		"2) Run /newbot (or /mybots)",
		"3) Copy the token (looks like 123456:ABC...)",
		"Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
		`Docs: ${formatDocsLink("/telegram")}`,
		"Website: https://openclaw.ai"
	].join("\n"), "Telegram bot token");
}
async function noteTelegramUserIdHelp(prompter) {
	await prompter.note([
		`1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
		"2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
		"3) Third-party: DM @userinfobot or @getidsbot",
		`Docs: ${formatDocsLink("/telegram")}`,
		"Website: https://openclaw.ai"
	].join("\n"), "Telegram user id");
}
function normalizeTelegramAllowFromInput(raw) {
	return raw.trim().replace(/^(telegram|tg):/i, "").trim();
}
function parseTelegramAllowFromId(raw) {
	const stripped = normalizeTelegramAllowFromInput(raw);
	return /^\d+$/.test(stripped) ? stripped : null;
}
async function promptTelegramAllowFrom(params) {
	const { cfg, prompter, accountId } = params;
	const resolved = resolveTelegramAccount({
		cfg,
		accountId
	});
	const existingAllowFrom = resolved.config.allowFrom ?? [];
	await noteTelegramUserIdHelp(prompter);
	const token = resolved.token;
	if (!token) await prompter.note("Telegram token missing; username lookup is unavailable.", "Telegram");
	return patchChannelConfigForAccount({
		cfg,
		channel: "telegram",
		accountId,
		patch: {
			dmPolicy: "allowlist",
			allowFrom: await promptResolvedAllowFrom({
				prompter,
				existing: existingAllowFrom,
				token,
				message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
				placeholder: "@username",
				label: "Telegram allowlist",
				parseInputs: splitOnboardingEntries,
				parseId: parseTelegramAllowFromId,
				invalidWithoutTokenNote: "Telegram token missing; use numeric sender ids (usernames require a bot token).",
				resolveEntries: async ({ token: tokenValue, entries }) => {
					return await Promise.all(entries.map(async (entry) => {
						const numericId = parseTelegramAllowFromId(entry);
						if (numericId) return {
							input: entry,
							resolved: true,
							id: numericId
						};
						const stripped = normalizeTelegramAllowFromInput(entry);
						if (!stripped) return {
							input: entry,
							resolved: false,
							id: null
						};
						const id = await fetchTelegramChatId({
							token: tokenValue,
							chatId: stripped.startsWith("@") ? stripped : `@${stripped}`
						});
						return {
							input: entry,
							resolved: Boolean(id),
							id
						};
					}));
				}
			})
		}
	});
}
async function promptTelegramAllowFromForAccount(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultTelegramAccountId(params.cfg)
	});
	return promptTelegramAllowFrom({
		cfg: params.cfg,
		prompter: params.prompter,
		accountId
	});
}
const dmPolicy = {
	label: "Telegram",
	channel: channel$1,
	policyKey: "channels.telegram.dmPolicy",
	allowFromKey: "channels.telegram.allowFrom",
	getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
		cfg,
		channel: "telegram",
		dmPolicy: policy
	}),
	promptAllowFrom: promptTelegramAllowFromForAccount
};
const telegramOnboardingAdapter = {
	channel: channel$1,
	getStatus: async ({ cfg }) => {
		const configured = listTelegramAccountIds(cfg).some((accountId) => Boolean(resolveTelegramAccount({
			cfg,
			accountId
		}).token));
		return {
			channel: channel$1,
			configured,
			statusLines: [`Telegram: ${configured ? "configured" : "needs token"}`],
			selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
			quickstartScore: configured ? 1 : 10
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
		const defaultTelegramAccountId = resolveDefaultTelegramAccountId(cfg);
		const telegramAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Telegram",
			accountOverride: accountOverrides.telegram,
			shouldPromptAccountIds,
			listAccountIds: listTelegramAccountIds,
			defaultAccountId: defaultTelegramAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveTelegramAccount({
			cfg: next,
			accountId: telegramAccountId
		});
		const accountConfigured = Boolean(resolvedAccount.token);
		const canUseEnv = telegramAccountId === DEFAULT_ACCOUNT_ID && !resolvedAccount.config.botToken && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
		const hasConfigToken = Boolean(resolvedAccount.config.botToken || resolvedAccount.config.tokenFile);
		if (!accountConfigured) await noteTelegramTokenHelp(prompter);
		const tokenResult = await promptSingleChannelToken({
			prompter,
			accountConfigured,
			canUseEnv,
			hasConfigToken,
			envPrompt: "TELEGRAM_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Telegram token already configured. Keep it?",
			inputPrompt: "Enter Telegram bot token"
		});
		next = applySingleTokenPromptResult({
			cfg: next,
			channel: "telegram",
			accountId: telegramAccountId,
			tokenPatchKey: "botToken",
			tokenResult
		});
		if (forceAllowFrom) next = await promptTelegramAllowFrom({
			cfg: next,
			prompter,
			accountId: telegramAccountId
		});
		return {
			cfg: next,
			accountId: telegramAccountId
		};
	},
	dmPolicy,
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel$1, false)
};

//#endregion
//#region src/config/merge-config.ts
function mergeConfigSection(base, patch, options = {}) {
	const next = { ...base ?? void 0 };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) {
			if (options.unsetOnUndefined?.includes(key)) delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}
function mergeWhatsAppConfig(cfg, patch, options) {
	return {
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options)
		}
	};
}

//#endregion
//#region src/channels/plugins/onboarding/whatsapp.ts
const channel = "whatsapp";
function setWhatsAppDmPolicy(cfg, dmPolicy) {
	return mergeWhatsAppConfig(cfg, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, allowFrom) {
	return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, selfChatMode) {
	return mergeWhatsAppConfig(cfg, { selfChatMode });
}
async function detectWhatsAppLinked(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await pathExists(path.join(authDir, "creds.json"));
}
async function promptWhatsAppOwnerAllowFrom(params) {
	const { prompter, existingAllowFrom } = params;
	await prompter.note("We need the sender/owner number so OpenClaw can allowlist you.", "WhatsApp number");
	const entry = await prompter.text({
		message: "Your personal WhatsApp number (the phone you will message from)",
		placeholder: "+15555550123",
		initialValue: existingAllowFrom[0],
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			if (!normalizeE164(raw)) return `Invalid number: ${raw}`;
		}
	});
	const normalized = normalizeE164(String(entry).trim());
	if (!normalized) throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
	return {
		normalized,
		allowFrom: normalizeAllowFromEntries([...existingAllowFrom.filter((item) => item !== "*"), normalized], normalizeE164)
	};
}
async function applyWhatsAppOwnerAllowlist(params) {
	const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
		prompter: params.prompter,
		existingAllowFrom: params.existingAllowFrom
	});
	let next = setWhatsAppSelfChatMode(params.cfg, true);
	next = setWhatsAppDmPolicy(next, "allowlist");
	next = setWhatsAppAllowFrom(next, allowFrom);
	await params.prompter.note([...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"), params.title);
	return next;
}
function parseWhatsAppAllowFromEntries(raw) {
	const parts = splitOnboardingEntries(raw);
	if (parts.length === 0) return { entries: [] };
	const entries = [];
	for (const part of parts) {
		if (part === "*") {
			entries.push("*");
			continue;
		}
		const normalized = normalizeE164(part);
		if (!normalized) return {
			entries: [],
			invalidEntry: part
		};
		entries.push(normalized);
	}
	return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}
async function promptWhatsAppAllowFrom(cfg, _runtime, prompter, options) {
	const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
	const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	if (options?.forceAllowlist) return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp allowlist",
		messageLines: ["Allowlist mode enabled."]
	});
	await prompter.note([
		"WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
		"- pairing (default): unknown senders get a pairing code; owner approves",
		"- allowlist: unknown senders are blocked",
		"- open: public inbound DMs (requires allowFrom to include \"*\")",
		"- disabled: ignore WhatsApp DMs",
		"",
		`Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
		`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
	].join("\n"), "WhatsApp DM access");
	if (await prompter.select({
		message: "WhatsApp phone setup",
		options: [{
			value: "personal",
			label: "This is my personal phone number"
		}, {
			value: "separate",
			label: "Separate phone just for OpenClaw"
		}]
	}) === "personal") return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp personal phone",
		messageLines: ["Personal phone mode enabled.", "- dmPolicy set to allowlist (pairing skipped)"]
	});
	const policy = await prompter.select({
		message: "WhatsApp DM policy",
		options: [
			{
				value: "pairing",
				label: "Pairing (recommended)"
			},
			{
				value: "allowlist",
				label: "Allowlist only (block unknown senders)"
			},
			{
				value: "open",
				label: "Open (public inbound DMs)"
			},
			{
				value: "disabled",
				label: "Disabled (ignore WhatsApp DMs)"
			}
		]
	});
	let next = setWhatsAppSelfChatMode(cfg, false);
	next = setWhatsAppDmPolicy(next, policy);
	if (policy === "open") {
		const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
		next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
		return next;
	}
	if (policy === "disabled") return next;
	const allowOptions = existingAllowFrom.length > 0 ? [
		{
			value: "keep",
			label: "Keep current allowFrom"
		},
		{
			value: "unset",
			label: "Unset allowFrom (use pairing approvals only)"
		},
		{
			value: "list",
			label: "Set allowFrom to specific numbers"
		}
	] : [{
		value: "unset",
		label: "Unset allowFrom (default)"
	}, {
		value: "list",
		label: "Set allowFrom to specific numbers"
	}];
	const mode = await prompter.select({
		message: "WhatsApp allowFrom (optional pre-allowlist)",
		options: allowOptions.map((opt) => ({
			value: opt.value,
			label: opt.label
		}))
	});
	if (mode === "keep") {} else if (mode === "unset") next = setWhatsAppAllowFrom(next, void 0);
	else {
		const allowRaw = await prompter.text({
			message: "Allowed sender numbers (comma-separated, E.164)",
			placeholder: "+15555550123, +447700900123",
			validate: (value) => {
				const raw = String(value ?? "").trim();
				if (!raw) return "Required";
				const parsed = parseWhatsAppAllowFromEntries(raw);
				if (parsed.entries.length === 0 && !parsed.invalidEntry) return "Required";
				if (parsed.invalidEntry) return `Invalid number: ${parsed.invalidEntry}`;
			}
		});
		const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
		next = setWhatsAppAllowFrom(next, parsed.entries);
	}
	return next;
}
const whatsappOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg, accountOverrides }) => {
		const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
		const accountId = resolveOnboardingAccountId({
			accountId: accountOverrides.whatsapp,
			defaultAccountId
		});
		const linked = await detectWhatsAppLinked(cfg, accountId);
		return {
			channel,
			configured: linked,
			statusLines: [`WhatsApp (${accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId}): ${linked ? "linked" : "not linked"}`],
			selectionHint: linked ? "linked" : "not linked",
			quickstartScore: linked ? 5 : 4
		};
	},
	configure: async ({ cfg, runtime, prompter, options, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
		const accountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "WhatsApp",
			accountOverride: accountOverrides.whatsapp,
			shouldPromptAccountIds: Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
			listAccountIds: listWhatsAppAccountIds,
			defaultAccountId: resolveDefaultWhatsAppAccountId(cfg)
		});
		let next = cfg;
		if (accountId !== DEFAULT_ACCOUNT_ID) next = {
			...next,
			channels: {
				...next.channels,
				whatsapp: {
					...next.channels?.whatsapp,
					accounts: {
						...next.channels?.whatsapp?.accounts,
						[accountId]: {
							...next.channels?.whatsapp?.accounts?.[accountId],
							enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true
						}
					}
				}
			}
		};
		const linked = await detectWhatsAppLinked(next, accountId);
		const { authDir } = resolveWhatsAppAuthDir({
			cfg: next,
			accountId
		});
		if (!linked) await prompter.note([
			"Scan the QR with WhatsApp on your phone.",
			`Credentials are stored under ${authDir}/ for future runs.`,
			`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
		].join("\n"), "WhatsApp linking");
		if (await prompter.confirm({
			message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
			initialValue: !linked
		})) try {
			await loginWeb(false, void 0, runtime, accountId);
		} catch (err) {
			runtime.error(`WhatsApp login failed: ${String(err)}`);
			await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
		}
		else if (!linked) await prompter.note(`Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`, "WhatsApp");
		next = await promptWhatsAppAllowFrom(next, runtime, prompter, { forceAllowlist: forceAllowFrom });
		return {
			cfg: next,
			accountId
		};
	},
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};

//#endregion
//#region src/commands/onboarding/registry.ts
const BUILTIN_ONBOARDING_ADAPTERS = [
	telegramOnboardingAdapter,
	whatsappOnboardingAdapter,
	discordOnboardingAdapter,
	slackOnboardingAdapter,
	signalOnboardingAdapter,
	imessageOnboardingAdapter
];
const CHANNEL_ONBOARDING_ADAPTERS = () => {
	const fromRegistry = listChannelPlugins().map((plugin) => plugin.onboarding ? [plugin.id, plugin.onboarding] : null).filter((entry) => Boolean(entry));
	const fromBuiltins = BUILTIN_ONBOARDING_ADAPTERS.map((adapter) => [adapter.channel, adapter]);
	return new Map([...fromBuiltins, ...fromRegistry]);
};
function getChannelOnboardingAdapter(channel) {
	return CHANNEL_ONBOARDING_ADAPTERS().get(channel);
}
function listChannelOnboardingAdapters() {
	return Array.from(CHANNEL_ONBOARDING_ADAPTERS().values());
}

//#endregion
//#region src/commands/onboard-channels.ts
var onboard_channels_exports = /* @__PURE__ */ __exportAll({
	noteChannelStatus: () => noteChannelStatus,
	setupChannels: () => setupChannels
});
function formatAccountLabel(accountId) {
	return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}
async function promptConfiguredAction(params) {
	const { prompter, label, supportsDisable, supportsDelete } = params;
	const updateOption = {
		value: "update",
		label: "Modify settings"
	};
	const disableOption = {
		value: "disable",
		label: "Disable (keeps config)"
	};
	const deleteOption = {
		value: "delete",
		label: "Delete config"
	};
	const skipOption = {
		value: "skip",
		label: "Skip (leave as-is)"
	};
	const options = [
		updateOption,
		...supportsDisable ? [disableOption] : [],
		...supportsDelete ? [deleteOption] : [],
		skipOption
	];
	return await prompter.select({
		message: `${label} already configured. What do you want to do?`,
		options,
		initialValue: "update"
	});
}
async function promptRemovalAccountId(params) {
	const { cfg, prompter, label, channel } = params;
	const plugin = getChannelPlugin(channel);
	if (!plugin) return DEFAULT_ACCOUNT_ID;
	const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
	const defaultAccountId = resolveChannelDefaultAccountId({
		plugin,
		cfg,
		accountIds
	});
	if (accountIds.length <= 1) return defaultAccountId;
	return normalizeAccountId(await prompter.select({
		message: `${label} account`,
		options: accountIds.map((accountId) => ({
			value: accountId,
			label: formatAccountLabel(accountId)
		})),
		initialValue: defaultAccountId
	})) ?? defaultAccountId;
}
async function collectChannelStatus(params) {
	const installedPlugins = listChannelPlugins();
	const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));
	const catalogEntries = listChannelPluginCatalogEntries({ workspaceDir: resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg)) }).filter((entry) => !installedIds.has(entry.id));
	const statusEntries = await Promise.all(listChannelOnboardingAdapters().map((adapter) => adapter.getStatus({
		cfg: params.cfg,
		options: params.options,
		accountOverrides: params.accountOverrides
	})));
	const statusByChannel = new Map(statusEntries.map((entry) => [entry.channel, entry]));
	const fallbackStatuses = listChatChannels().filter((meta) => !statusByChannel.has(meta.id)).map((meta) => {
		const configured = isChannelConfigured(params.cfg, meta.id);
		const statusLabel = configured ? "configured (plugin disabled)" : "not configured";
		return {
			channel: meta.id,
			configured,
			statusLines: [`${meta.label}: ${statusLabel}`],
			selectionHint: configured ? "configured · plugin disabled" : "not configured",
			quickstartScore: 0
		};
	});
	const catalogStatuses = catalogEntries.map((entry) => ({
		channel: entry.id,
		configured: false,
		statusLines: [`${entry.meta.label}: install plugin to enable`],
		selectionHint: "plugin · install",
		quickstartScore: 0
	}));
	const combinedStatuses = [
		...statusEntries,
		...fallbackStatuses,
		...catalogStatuses
	];
	return {
		installedPlugins,
		catalogEntries,
		statusByChannel: new Map(combinedStatuses.map((entry) => [entry.channel, entry])),
		statusLines: combinedStatuses.flatMap((entry) => entry.statusLines)
	};
}
async function noteChannelStatus(params) {
	const { statusLines } = await collectChannelStatus({
		cfg: params.cfg,
		options: params.options,
		accountOverrides: params.accountOverrides ?? {}
	});
	if (statusLines.length > 0) await params.prompter.note(statusLines.join("\n"), "Channel status");
}
async function noteChannelPrimer(prompter, channels) {
	const channelLines = channels.map((channel) => formatChannelPrimerLine({
		id: channel.id,
		label: channel.label,
		selectionLabel: channel.label,
		docsPath: "/",
		blurb: channel.blurb
	}));
	await prompter.note([
		"DM security: default is pairing; unknown DMs get a pairing code.",
		`Approve with: ${formatCliCommand("openclaw pairing approve <channel> <code>")}`,
		"Public DMs require dmPolicy=\"open\" + allowFrom=[\"*\"].",
		"Multi-user DMs: run: " + formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") + " (or \"per-account-channel-peer\" for multi-account channels) to isolate sessions.",
		`Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
		"",
		...channelLines
	].join("\n"), "How channels work");
}
function resolveQuickstartDefault(statusByChannel) {
	let best = null;
	for (const [channel, status] of statusByChannel) {
		if (status.quickstartScore == null) continue;
		if (!best || status.quickstartScore > best.score) best = {
			channel,
			score: status.quickstartScore
		};
	}
	return best?.channel;
}
async function maybeConfigureDmPolicies(params) {
	const { selection, prompter, accountIdsByChannel } = params;
	const dmPolicies = selection.map((channel) => getChannelOnboardingAdapter(channel)?.dmPolicy).filter(Boolean);
	if (dmPolicies.length === 0) return params.cfg;
	if (!await prompter.confirm({
		message: "Configure DM access policies now? (default: pairing)",
		initialValue: false
	})) return params.cfg;
	let cfg = params.cfg;
	const selectPolicy = async (policy) => {
		await prompter.note([
			"Default: pairing (unknown DMs get a pairing code).",
			`Approve: ${formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`)}`,
			`Allowlist DMs: ${policy.policyKey}="allowlist" + ${policy.allowFromKey} entries.`,
			`Public DMs: ${policy.policyKey}="open" + ${policy.allowFromKey} includes "*".`,
			"Multi-user DMs: run: " + formatCliCommand("openclaw config set session.dmScope \"per-channel-peer\"") + " (or \"per-account-channel-peer\" for multi-account channels) to isolate sessions.",
			`Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`
		].join("\n"), `${policy.label} DM access`);
		return await prompter.select({
			message: `${policy.label} DM policy`,
			options: [
				{
					value: "pairing",
					label: "Pairing (recommended)"
				},
				{
					value: "allowlist",
					label: "Allowlist (specific users only)"
				},
				{
					value: "open",
					label: "Open (public inbound DMs)"
				},
				{
					value: "disabled",
					label: "Disabled (ignore DMs)"
				}
			]
		});
	};
	for (const policy of dmPolicies) {
		const current = policy.getCurrent(cfg);
		const nextPolicy = await selectPolicy(policy);
		if (nextPolicy !== current) cfg = policy.setPolicy(cfg, nextPolicy);
		if (nextPolicy === "allowlist" && policy.promptAllowFrom) cfg = await policy.promptAllowFrom({
			cfg,
			prompter,
			accountId: accountIdsByChannel?.get(policy.channel)
		});
	}
	return cfg;
}
async function setupChannels(cfg, runtime, prompter, options) {
	let next = cfg;
	const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
	const accountOverrides = { ...options?.accountIds };
	if (options?.whatsappAccountId?.trim()) accountOverrides.whatsapp = options.whatsappAccountId.trim();
	const { installedPlugins, catalogEntries, statusByChannel, statusLines } = await collectChannelStatus({
		cfg: next,
		options,
		accountOverrides
	});
	if (!options?.skipStatusNote && statusLines.length > 0) await prompter.note(statusLines.join("\n"), "Channel status");
	if (!(options?.skipConfirm ? true : await prompter.confirm({
		message: "Configure chat channels now?",
		initialValue: true
	}))) return cfg;
	const corePrimer = listChatChannels().map((meta) => ({
		id: meta.id,
		label: meta.label,
		blurb: meta.blurb
	}));
	const coreIds = new Set(corePrimer.map((entry) => entry.id));
	await noteChannelPrimer(prompter, [
		...corePrimer,
		...installedPlugins.filter((plugin) => !coreIds.has(plugin.id)).map((plugin) => ({
			id: plugin.id,
			label: plugin.meta.label,
			blurb: plugin.meta.blurb
		})),
		...catalogEntries.filter((entry) => !coreIds.has(entry.id)).map((entry) => ({
			id: entry.id,
			label: entry.meta.label,
			blurb: entry.meta.blurb
		}))
	]);
	const quickstartDefault = options?.initialSelection?.[0] ?? resolveQuickstartDefault(statusByChannel);
	const shouldPromptAccountIds = options?.promptAccountIds === true;
	const accountIdsByChannel = /* @__PURE__ */ new Map();
	const recordAccount = (channel, accountId) => {
		options?.onAccountId?.(channel, accountId);
		getChannelOnboardingAdapter(channel)?.onAccountRecorded?.(accountId, options);
		accountIdsByChannel.set(channel, accountId);
	};
	const selection = [];
	const addSelection = (channel) => {
		if (!selection.includes(channel)) selection.push(channel);
	};
	const resolveDisabledHint = (channel) => {
		const plugin = getChannelPlugin(channel);
		if (!plugin) {
			if (next.plugins?.entries?.[channel]?.enabled === false) return "plugin disabled";
			if (next.plugins?.enabled === false) return "plugins disabled";
			return;
		}
		const accountId = resolveChannelDefaultAccountId({
			plugin,
			cfg: next
		});
		const account = plugin.config.resolveAccount(next, accountId);
		let enabled;
		if (plugin.config.isEnabled) enabled = plugin.config.isEnabled(account, next);
		else if (typeof account?.enabled === "boolean") enabled = account.enabled;
		else if (typeof next.channels?.[channel]?.enabled === "boolean") enabled = next.channels[channel]?.enabled;
		return enabled === false ? "disabled" : void 0;
	};
	const buildSelectionOptions = (entries) => entries.map((entry) => {
		const status = statusByChannel.get(entry.id);
		const disabledHint = resolveDisabledHint(entry.id);
		const hint = [status?.selectionHint, disabledHint].filter(Boolean).join(" · ") || void 0;
		return {
			value: entry.meta.id,
			label: entry.meta.selectionLabel ?? entry.meta.label,
			...hint ? { hint } : {}
		};
	});
	const getChannelEntries = () => {
		const core = listChatChannels();
		const installed = listChannelPlugins();
		const installedIds = new Set(installed.map((plugin) => plugin.id));
		const catalog = listChannelPluginCatalogEntries({ workspaceDir: resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next)) }).filter((entry) => !installedIds.has(entry.id));
		const metaById = /* @__PURE__ */ new Map();
		for (const meta of core) metaById.set(meta.id, meta);
		for (const plugin of installed) metaById.set(plugin.id, plugin.meta);
		for (const entry of catalog) if (!metaById.has(entry.id)) metaById.set(entry.id, entry.meta);
		return {
			entries: Array.from(metaById, ([id, meta]) => ({
				id,
				meta
			})),
			catalog,
			catalogById: new Map(catalog.map((entry) => [entry.id, entry]))
		};
	};
	const refreshStatus = async (channel) => {
		const adapter = getChannelOnboardingAdapter(channel);
		if (!adapter) return;
		const status = await adapter.getStatus({
			cfg: next,
			options,
			accountOverrides
		});
		statusByChannel.set(channel, status);
	};
	const ensureBundledPluginEnabled = async (channel) => {
		if (getChannelPlugin(channel)) return true;
		const result = enablePluginInConfig(next, channel);
		next = result.config;
		if (!result.enabled) {
			await prompter.note(`Cannot enable ${channel}: ${result.reason ?? "plugin disabled"}.`, "Channel setup");
			return false;
		}
		const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
		reloadOnboardingPluginRegistry({
			cfg: next,
			runtime,
			workspaceDir
		});
		if (!getChannelPlugin(channel)) {
			if (getChannelOnboardingAdapter(channel)) {
				await prompter.note(`${channel} plugin not available (continuing with onboarding). If the channel still doesn't work after setup, run \`${formatCliCommand("openclaw plugins list")}\` and \`${formatCliCommand("openclaw plugins enable " + channel)}\`, then restart the gateway.`, "Channel setup");
				await refreshStatus(channel);
				return true;
			}
			await prompter.note(`${channel} plugin not available.`, "Channel setup");
			return false;
		}
		await refreshStatus(channel);
		return true;
	};
	const applyOnboardingResult = async (channel, result) => {
		next = result.cfg;
		if (result.accountId) recordAccount(channel, result.accountId);
		addSelection(channel);
		await refreshStatus(channel);
	};
	const applyCustomOnboardingResult = async (channel, result) => {
		if (result === "skip") return false;
		await applyOnboardingResult(channel, result);
		return true;
	};
	const configureChannel = async (channel) => {
		const adapter = getChannelOnboardingAdapter(channel);
		if (!adapter) {
			await prompter.note(`${channel} does not support onboarding yet.`, "Channel setup");
			return;
		}
		await applyOnboardingResult(channel, await adapter.configure({
			cfg: next,
			runtime,
			prompter,
			options,
			accountOverrides,
			shouldPromptAccountIds,
			forceAllowFrom: forceAllowFromChannels.has(channel)
		}));
	};
	const handleConfiguredChannel = async (channel, label) => {
		const plugin = getChannelPlugin(channel);
		const adapter = getChannelOnboardingAdapter(channel);
		if (adapter?.configureWhenConfigured) {
			if (!await applyCustomOnboardingResult(channel, await adapter.configureWhenConfigured({
				cfg: next,
				runtime,
				prompter,
				options,
				accountOverrides,
				shouldPromptAccountIds,
				forceAllowFrom: forceAllowFromChannels.has(channel),
				configured: true,
				label
			}))) return;
			return;
		}
		const supportsDisable = Boolean(options?.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable));
		const supportsDelete = Boolean(options?.allowDisable && plugin?.config.deleteAccount);
		const action = await promptConfiguredAction({
			prompter,
			label,
			supportsDisable,
			supportsDelete
		});
		if (action === "skip") return;
		if (action === "update") {
			await configureChannel(channel);
			return;
		}
		if (!options?.allowDisable) return;
		if (action === "delete" && !supportsDelete) {
			await prompter.note(`${label} does not support deleting config entries.`, "Remove channel");
			return;
		}
		const resolvedAccountId = normalizeAccountId((action === "delete" ? Boolean(plugin?.config.deleteAccount) : Boolean(plugin?.config.setAccountEnabled)) ? await promptRemovalAccountId({
			cfg: next,
			prompter,
			label,
			channel
		}) : DEFAULT_ACCOUNT_ID) ?? (plugin ? resolveChannelDefaultAccountId({
			plugin,
			cfg: next
		}) : DEFAULT_ACCOUNT_ID);
		const accountLabel = formatAccountLabel(resolvedAccountId);
		if (action === "delete") {
			if (!await prompter.confirm({
				message: `Delete ${label} account "${accountLabel}"?`,
				initialValue: false
			})) return;
			if (plugin?.config.deleteAccount) next = plugin.config.deleteAccount({
				cfg: next,
				accountId: resolvedAccountId
			});
			await refreshStatus(channel);
			return;
		}
		if (plugin?.config.setAccountEnabled) next = plugin.config.setAccountEnabled({
			cfg: next,
			accountId: resolvedAccountId,
			enabled: false
		});
		else if (adapter?.disable) next = adapter.disable(next);
		await refreshStatus(channel);
	};
	const handleChannelChoice = async (channel) => {
		const { catalogById } = getChannelEntries();
		const catalogEntry = catalogById.get(channel);
		if (catalogEntry) {
			const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
			const result = await ensureOnboardingPluginInstalled({
				cfg: next,
				entry: catalogEntry,
				prompter,
				runtime,
				workspaceDir
			});
			next = result.cfg;
			if (!result.installed) return;
			reloadOnboardingPluginRegistry({
				cfg: next,
				runtime,
				workspaceDir
			});
			await refreshStatus(channel);
		} else if (!await ensureBundledPluginEnabled(channel)) return;
		const plugin = getChannelPlugin(channel);
		const adapter = getChannelOnboardingAdapter(channel);
		const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
		const configured = statusByChannel.get(channel)?.configured ?? false;
		if (adapter?.configureInteractive) {
			if (!await applyCustomOnboardingResult(channel, await adapter.configureInteractive({
				cfg: next,
				runtime,
				prompter,
				options,
				accountOverrides,
				shouldPromptAccountIds,
				forceAllowFrom: forceAllowFromChannels.has(channel),
				configured,
				label
			}))) return;
			return;
		}
		if (configured) {
			await handleConfiguredChannel(channel, label);
			return;
		}
		await configureChannel(channel);
	};
	if (options?.quickstartDefaults) {
		const { entries } = getChannelEntries();
		const choice = await prompter.select({
			message: "Select channel (QuickStart)",
			options: [...buildSelectionOptions(entries), {
				value: "__skip__",
				label: "Skip for now",
				hint: `You can add channels later via \`${formatCliCommand("openclaw channels add")}\``
			}],
			initialValue: quickstartDefault
		});
		if (choice !== "__skip__") await handleChannelChoice(choice);
	} else {
		const doneValue = "__done__";
		const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
		while (true) {
			const { entries } = getChannelEntries();
			const choice = await prompter.select({
				message: "Select a channel",
				options: [...buildSelectionOptions(entries), {
					value: doneValue,
					label: "Finished",
					hint: selection.length > 0 ? "Done" : "Skip for now"
				}],
				initialValue
			});
			if (choice === doneValue) break;
			await handleChannelChoice(choice);
		}
	}
	options?.onSelection?.(selection);
	const selectionNotes = /* @__PURE__ */ new Map();
	const { entries: selectionEntries } = getChannelEntries();
	for (const entry of selectionEntries) selectionNotes.set(entry.id, formatChannelSelectionLine(entry.meta, formatDocsLink));
	const selectedLines = selection.map((channel) => selectionNotes.get(channel)).filter((line) => Boolean(line));
	if (selectedLines.length > 0) await prompter.note(selectedLines.join("\n"), "Selected channels");
	if (!options?.skipDmPolicyPrompt) next = await maybeConfigureDmPolicies({
		cfg: next,
		selection,
		prompter,
		accountIdsByChannel
	});
	return next;
}

//#endregion
export { reloadOnboardingPluginRegistry as a, ensureOnboardingPluginInstalled as i, onboard_channels_exports as n, setupChannels as r, noteChannelStatus as t };