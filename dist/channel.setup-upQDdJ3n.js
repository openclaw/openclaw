import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { d as normalizeSecretInputString, s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { A as promptLegacyChannelAllowFromForAccount, I as resolveEntriesWithOptionalToken, J as setSetupChannelEnabled, S as parseMentionOrPrefixedId, T as patchChannelConfigForAccount, f as createStandardChannelSetupStatus, i as createAccountScopedGroupAccessSection, o as createLegacyCompatChannelDmPolicy, r as createAccountScopedAllowFromSection } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-runtime-BRbeJqWD.js";
import "./setup-tools-DuiMNzp5.js";
import "./account-resolution-Dy8RKAMt.js";
import { n as resolveDiscordToken } from "./token-CyE3_lif.js";
import { a as mergeDiscordAccountConfig, c as resolveDiscordAccountAllowFrom, l as resolveDiscordAccountConfig, o as resolveDefaultDiscordAccountId } from "./accounts-DIRzXd2H.js";
import { r as discordSetupAdapter, t as createDiscordPluginBase } from "./shared-DeIHngQV.js";
import { t as resolveDiscordChannelAllowlist } from "./resolve-channels-eoA5EMZW.js";
import { t as resolveDiscordUserAllowlist } from "./resolve-users-DM6FJfvT.js";
//#region extensions/discord/src/setup-account-state.ts
function inspectConfiguredToken(value) {
	const normalized = normalizeSecretInputString(value);
	if (normalized) return {
		token: normalized.replace(/^Bot\s+/i, ""),
		tokenSource: "config",
		tokenStatus: "available"
	};
	if (hasConfiguredSecretInput(value)) return {
		token: "",
		tokenSource: "config",
		tokenStatus: "configured_unavailable"
	};
	return null;
}
function resolveDefaultDiscordSetupAccountId(cfg) {
	return resolveDefaultDiscordAccountId(cfg);
}
function resolveDiscordSetupAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordSetupAccountId(params.cfg));
	return {
		accountId,
		config: mergeDiscordAccountConfig(params.cfg, accountId)
	};
}
function inspectDiscordSetupAccount(params) {
	const { accountId, config } = resolveDiscordSetupAccountConfig(params);
	const enabled = params.cfg.channels?.discord?.enabled !== false && config.enabled !== false;
	const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
	const hasAccountToken = Boolean(accountConfig && Object.prototype.hasOwnProperty.call(accountConfig, "token"));
	const accountToken = inspectConfiguredToken(accountConfig?.token);
	if (accountToken) return {
		accountId,
		enabled,
		token: accountToken.token,
		tokenSource: accountToken.tokenSource,
		tokenStatus: accountToken.tokenStatus,
		configured: true,
		config
	};
	if (hasAccountToken) return {
		accountId,
		enabled,
		token: "",
		tokenSource: "none",
		tokenStatus: "missing",
		configured: false,
		config
	};
	const channelToken = inspectConfiguredToken(params.cfg.channels?.discord?.token);
	if (channelToken) return {
		accountId,
		enabled,
		token: channelToken.token,
		tokenSource: channelToken.tokenSource,
		tokenStatus: channelToken.tokenStatus,
		configured: true,
		config
	};
	const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
	if (tokenResolution.token) return {
		accountId,
		enabled,
		token: tokenResolution.token,
		tokenSource: tokenResolution.source,
		tokenStatus: "available",
		configured: true,
		config
	};
	return {
		accountId,
		enabled,
		token: "",
		tokenSource: "none",
		tokenStatus: "missing",
		configured: false,
		config
	};
}
//#endregion
//#region extensions/discord/src/setup-core.ts
const t$1 = createSetupTranslator();
const channel$1 = "discord";
const DISCORD_TOKEN_HELP_LINES = [
	t$1("wizard.discord.tokenHelpCreateApplication"),
	t$1("wizard.discord.tokenHelpCopyToken"),
	t$1("wizard.discord.tokenHelpInviteBot"),
	t$1("wizard.discord.tokenHelpMessageContentIntent"),
	t$1("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") })
];
function mapDiscordSetupAllowlistEntries(resolved) {
	if (!Array.isArray(resolved)) return [];
	return resolved.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const row = entry;
		if (row.resolved === false) return [];
		const guildKey = normalizeOptionalString(row.guildId ?? row.guildKey);
		if (!guildKey) return [];
		const channelKey = normalizeOptionalString(row.channelId ?? row.channelKey);
		return channelKey ? [{
			guildKey,
			channelKey
		}] : [{ guildKey }];
	});
}
function setDiscordGuildChannelAllowlist(cfg, accountId, entries) {
	const guilds = { ...accountId === "default" ? cfg.channels?.discord?.guilds ?? {} : cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {} };
	for (const entry of entries) {
		const guildKey = entry.guildKey || "*";
		const existing = guilds[guildKey] ?? {};
		if (entry.channelKey) {
			const channels = { ...existing.channels };
			channels[entry.channelKey] = { enabled: true };
			guilds[guildKey] = {
				...existing,
				channels
			};
		} else guilds[guildKey] = existing;
	}
	return patchChannelConfigForAccount({
		cfg,
		channel: channel$1,
		accountId,
		patch: { guilds }
	});
}
function parseDiscordAllowFromId(value) {
	return parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixPattern: /^(user:|discord:)/i,
		idPattern: /^\d+$/
	});
}
function createDiscordSetupWizardBase(handlers) {
	const discordDmPolicy = createLegacyCompatChannelDmPolicy({
		label: "Discord",
		channel: channel$1,
		promptAllowFrom: handlers.promptAllowFrom
	});
	return {
		channel: channel$1,
		status: createStandardChannelSetupStatus({
			channelLabel: "Discord",
			configuredLabel: t$1("wizard.channels.statusConfigured"),
			unconfiguredLabel: t$1("wizard.channels.statusNeedsToken"),
			configuredHint: t$1("wizard.channels.statusConfigured"),
			unconfiguredHint: t$1("wizard.channels.statusNeedsToken"),
			configuredScore: 2,
			unconfiguredScore: 1,
			resolveConfigured: ({ cfg, accountId }) => inspectDiscordSetupAccount({
				cfg,
				accountId
			}).configured
		}),
		credentials: [{
			inputKey: "token",
			providerHint: channel$1,
			credentialLabel: t$1("wizard.discord.botToken"),
			preferredEnvVar: "DISCORD_BOT_TOKEN",
			helpTitle: t$1("wizard.discord.botToken"),
			helpLines: DISCORD_TOKEN_HELP_LINES,
			envPrompt: t$1("wizard.discord.tokenEnvPrompt"),
			keepPrompt: t$1("wizard.discord.tokenKeepPrompt"),
			inputPrompt: t$1("wizard.discord.tokenInputPrompt"),
			allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
			inspect: ({ cfg, accountId }) => {
				const account = inspectDiscordSetupAccount({
					cfg,
					accountId
				});
				return {
					accountConfigured: account.configured,
					hasConfiguredValue: account.tokenStatus !== "missing",
					resolvedValue: normalizeOptionalString(account.token),
					envValue: accountId === "default" ? normalizeOptionalString(process.env.DISCORD_BOT_TOKEN) : void 0
				};
			}
		}],
		groupAccess: createAccountScopedGroupAccessSection({
			channel: channel$1,
			label: t$1("wizard.discord.channelsLabel"),
			placeholder: "My Server/#general, guildId/channelId, #support",
			currentPolicy: ({ cfg, accountId }) => resolveDiscordSetupAccountConfig({
				cfg,
				accountId
			}).config.groupPolicy ?? "allowlist",
			currentEntries: ({ cfg, accountId }) => Object.entries(resolveDiscordSetupAccountConfig({
				cfg,
				accountId
			}).config.guilds ?? {}).flatMap(([guildKey, value]) => {
				const channels = value?.channels ?? {};
				const channelKeys = Object.keys(channels);
				if (channelKeys.length === 0) return [/^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey];
				return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
			}),
			updatePrompt: ({ cfg, accountId }) => Boolean(resolveDiscordSetupAccountConfig({
				cfg,
				accountId
			}).config.guilds),
			resolveAllowlist: handlers.resolveGroupAllowlist,
			fallbackResolved: (entries) => entries.map((input) => ({
				input,
				resolved: false
			})),
			applyAllowlist: ({ cfg, accountId, resolved }) => setDiscordGuildChannelAllowlist(cfg, accountId, mapDiscordSetupAllowlistEntries(resolved))
		}),
		allowFrom: createAccountScopedAllowFromSection({
			channel: channel$1,
			credentialInputKey: "token",
			helpTitle: "Discord allowlist",
			helpLines: [
				t$1("wizard.discord.allowlistIntro"),
				t$1("wizard.discord.examples"),
				"- 123456789012345678",
				"- @alice",
				"- alice#1234",
				t$1("wizard.discord.multipleEntries"),
				t$1("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") })
			],
			message: t$1("wizard.discord.allowFromPrompt"),
			placeholder: "@alice, 123456789012345678",
			invalidWithoutCredentialNote: t$1("wizard.discord.allowFromInvalidWithoutToken"),
			parseId: parseDiscordAllowFromId,
			resolveEntries: handlers.resolveAllowFromEntries
		}),
		dmPolicy: discordDmPolicy,
		disable: (cfg) => setSetupChannelEnabled(cfg, channel$1, false)
	};
}
//#endregion
//#region extensions/discord/src/setup-surface.ts
const t = createSetupTranslator();
const channel = "discord";
async function resolveDiscordAllowFromEntries(params) {
	return await resolveEntriesWithOptionalToken({
		token: params.token,
		entries: params.entries,
		buildWithoutToken: (input) => ({
			input,
			resolved: false,
			id: null
		}),
		resolveEntries: async ({ token, entries }) => (await resolveDiscordUserAllowlist({
			token,
			entries
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id ?? null
		}))
	});
}
async function promptDiscordAllowFrom(params) {
	return await promptLegacyChannelAllowFromForAccount({
		cfg: params.cfg,
		channel,
		prompter: params.prompter,
		accountId: params.accountId,
		defaultAccountId: resolveDefaultDiscordSetupAccountId(params.cfg),
		resolveAccount: (cfg, accountId) => resolveDiscordSetupAccountConfig({
			cfg,
			accountId
		}),
		noteTitle: t("wizard.discord.allowlistTitle"),
		noteLines: [
			t("wizard.discord.allowlistIntro"),
			t("wizard.discord.examples"),
			"- 123456789012345678",
			"- @alice",
			"- alice#1234",
			t("wizard.discord.multipleEntries"),
			t("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") })
		],
		message: t("wizard.discord.allowFromPrompt"),
		placeholder: "@alice, 123456789012345678",
		parseId: parseDiscordAllowFromId,
		invalidWithoutTokenNote: t("wizard.discord.allowFromInvalidWithoutToken"),
		resolveExisting: (account, cfg) => resolveDiscordAccountAllowFrom({
			cfg,
			accountId: account.accountId
		}) ?? [],
		resolveToken: (account) => resolveDiscordToken(params.cfg, { accountId: account.accountId }).token,
		resolveEntries: async ({ token, entries }) => (await resolveDiscordUserAllowlist({
			token,
			entries
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id ?? null
		}))
	});
}
async function resolveDiscordGroupAllowlist(params) {
	return await resolveEntriesWithOptionalToken({
		token: resolveDiscordToken(params.cfg, { accountId: params.accountId }).token || (typeof params.credentialValues.token === "string" ? params.credentialValues.token : ""),
		entries: params.entries,
		buildWithoutToken: (input) => ({
			input,
			resolved: false
		}),
		resolveEntries: async ({ token, entries }) => await resolveDiscordChannelAllowlist({
			token,
			entries
		})
	});
}
//#endregion
//#region extensions/discord/src/channel.setup.ts
const discordSetupPlugin = { ...createDiscordPluginBase({
	setupWizard: createDiscordSetupWizardBase({
		promptAllowFrom: promptDiscordAllowFrom,
		resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => await resolveDiscordAllowFromEntries({
			token: resolveDiscordToken(cfg, { accountId }).token || (typeof credentialValues.token === "string" ? credentialValues.token : ""),
			entries
		}),
		resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries }) => await resolveDiscordGroupAllowlist({
			cfg,
			accountId,
			credentialValues,
			entries
		})
	}),
	setup: discordSetupAdapter
}) };
//#endregion
export { discordSetupPlugin as t };
