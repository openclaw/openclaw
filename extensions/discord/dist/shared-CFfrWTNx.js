import { a as mergeDiscordAccountConfig, c as resolveDiscordAccountAllowFrom, d as resolveDiscordAccountDmPolicy, n as isDiscordAccountEnabledForRuntime, o as resolveDefaultDiscordAccountId, r as listDiscordAccountIds, s as resolveDiscordAccount, u as resolveDiscordAccountDisabledReason } from "./accounts-CaHGiVB4.js";
import { t as inspectDiscordAccount } from "./account-inspect-BcQAxhKY.js";
import { i as getChatChannelMeta } from "./channel-api-CTSWMrnD.js";
import { t as DiscordChannelConfigSchema } from "./config-schema-Cmxmo3UR.js";
import { n as normalizeCompatibilityConfig } from "./doctor-contract-Dxq4VIkE.js";
import { t as DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared-DU8RcnF5.js";
import { n as secretTargetRegistryEntries, t as collectRuntimeConfigAssignments } from "./secret-config-contract-CoGryS5c.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "./security-contract-ei3Mz8Sa.js";
import { t as deriveLegacySessionChatType } from "./session-contract-goJZckp2.js";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { adaptScopedAccountAccessor, createScopedChannelConfigAdapter, createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createEnvPatchedAccountSetupAdapter } from "openclaw/plugin-sdk/setup-adapter-runtime";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
//#region extensions/discord/src/security.ts
const resolveDiscordDmPolicy = createScopedDmSecurityResolver({
	channelKey: "discord",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	resolveAccess: ({ cfg, account }) => ({
		dmPolicy: resolveDiscordAccountDmPolicy({
			cfg,
			accountId: account.accountId
		}),
		allowFrom: resolveDiscordAccountAllowFrom({
			cfg,
			accountId: account.accountId
		})
	}),
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => raw.trim().replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1")
});
const collectDiscordSecurityWarnings = createOpenProviderConfiguredRouteWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.discord !== void 0,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	resolveRouteAllowlistConfigured: (account) => Object.keys(account.config.guilds ?? {}).length > 0,
	configureRouteAllowlist: {
		surface: "Discord guilds",
		openScope: "any channel not explicitly denied",
		groupPolicyPath: "channels.discord.groupPolicy",
		routeAllowlistPath: "channels.discord.guilds.<id>.channels"
	},
	missingRouteAllowlist: {
		surface: "Discord guilds",
		openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
		remediation: "Set channels.discord.groupPolicy=\"allowlist\" and configure channels.discord.guilds.<id>.channels"
	}
});
let discordSecurityAuditModulePromise;
async function loadDiscordSecurityAuditModule() {
	discordSecurityAuditModulePromise ??= import("./security-audit.runtime-DBV1T1_N.js");
	return await discordSecurityAuditModulePromise;
}
const discordSecurityAdapter = {
	resolveDmPolicy: resolveDiscordDmPolicy,
	collectWarnings: collectDiscordSecurityWarnings,
	collectAuditFindings: async (params) => (await loadDiscordSecurityAuditModule()).collectDiscordSecurityAuditFindings(params)
};
const discordSetupAdapter = createEnvPatchedAccountSetupAdapter({
	channelKey: "discord",
	defaultAccountOnlyEnvError: "DISCORD_BOT_TOKEN can only be used for the default account.",
	missingCredentialError: "Discord requires token (or --use-env).",
	hasCredentials: (input) => Boolean(input.token),
	buildPatch: (input) => input.token ? { token: input.token } : {}
});
//#endregion
//#region extensions/discord/src/shared.ts
const DISCORD_CHANNEL = "discord";
let discordDoctorModulePromise;
async function loadDiscordDoctorModule() {
	discordDoctorModulePromise ??= import("./doctor-Bgzf3Du2.js");
	return await discordDoctorModulePromise;
}
const discordDoctor = {
	dmAllowFromMode: "topOnly",
	groupModel: "route",
	groupAllowFromFallbackToAllowFrom: false,
	warnOnEmptyGroupSenderAllowlist: false,
	legacyConfigRules: DISCORD_LEGACY_CONFIG_RULES,
	normalizeCompatibilityConfig,
	collectPreviewWarnings: async (params) => (await loadDiscordDoctorModule()).discordDoctor.collectPreviewWarnings?.(params) ?? [],
	collectMutableAllowlistWarnings: async (params) => (await loadDiscordDoctorModule()).discordDoctor.collectMutableAllowlistWarnings?.(params) ?? [],
	repairConfig: async (params) => (await loadDiscordDoctorModule()).discordDoctor.repairConfig?.(params) ?? {
		config: params.cfg,
		changes: []
	}
};
function resolveDiscordConfigAccessorAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(params.cfg));
	const config = mergeDiscordAccountConfig(params.cfg, accountId);
	return {
		allowFrom: resolveDiscordAccountAllowFrom({
			cfg: params.cfg,
			accountId
		}),
		defaultTo: config.defaultTo
	};
}
const discordConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: DISCORD_CHANNEL,
	listAccountIds: listDiscordAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveDiscordAccount),
	resolveAccessorAccount: resolveDiscordConfigAccessorAccount,
	inspectAccount: adaptScopedAccountAccessor(inspectDiscordAccount),
	defaultAccountId: resolveDefaultDiscordAccountId,
	clearBaseFields: ["token", "name"],
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.defaultTo
});
function createDiscordPluginBase(params) {
	return {
		id: DISCORD_CHANNEL,
		...params.setupWizard ? { setupWizard: params.setupWizard } : {},
		meta: { ...getChatChannelMeta(DISCORD_CHANNEL) },
		capabilities: {
			chatTypes: [
				"direct",
				"channel",
				"thread"
			],
			polls: true,
			reactions: true,
			threads: true,
			media: true,
			tts: { voice: { synthesisTarget: "voice-note" } },
			nativeCommands: true
		},
		commands: {
			nativeCommandsAutoEnabled: true,
			nativeSkillsAutoEnabled: true,
			resolveNativeCommandName: ({ commandKey, defaultName }) => commandKey === "tts" ? "voice" : defaultName
		},
		doctor: discordDoctor,
		streaming: { blockStreamingCoalesceDefaults: {
			minChars: 1500,
			idleMs: 1e3
		} },
		reload: { configPrefixes: ["channels.discord"] },
		configSchema: DiscordChannelConfigSchema,
		config: {
			...discordConfigAdapter,
			hasConfiguredState: ({ env }) => typeof env?.DISCORD_BOT_TOKEN === "string" && env.DISCORD_BOT_TOKEN.trim().length > 0,
			isEnabled: (account, cfg) => isDiscordAccountEnabledForRuntime(account, cfg),
			disabledReason: (account, cfg) => resolveDiscordAccountDisabledReason(account, cfg),
			isConfigured: (account) => Boolean(account.token?.trim()),
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: Boolean(account.token?.trim()),
				extra: {
					tokenSource: account.tokenSource,
					tokenStatus: account.tokenStatus
				}
			})
		},
		messaging: { deriveLegacySessionChatType },
		security: discordSecurityAdapter,
		secrets: {
			secretTargetRegistryEntries,
			unsupportedSecretRefSurfacePatterns,
			collectUnsupportedSecretRefConfigCandidates,
			collectRuntimeConfigAssignments
		},
		setup: params.setup
	};
}
//#endregion
export { discordSecurityAdapter as i, discordConfigAdapter as n, discordSetupAdapter as r, createDiscordPluginBase as t };
