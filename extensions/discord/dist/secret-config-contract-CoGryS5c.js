import { collectNestedChannelFieldAssignments, collectSimpleChannelFieldAssignments, getChannelSurface, isBaseFieldActiveForChannelSurface, isEnabledFlag, isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { collectNestedChannelTtsAssignments } from "openclaw/plugin-sdk/channel-secret-tts-runtime";
//#region extensions/discord/src/secret-config-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.discord.accounts.*.pluralkit.token",
		targetType: "channels.discord.accounts.*.pluralkit.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.pluralkit.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.token",
		targetType: "channels.discord.accounts.*.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
		targetType: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 6
	},
	{
		id: "channels.discord.pluralkit.token",
		targetType: "channels.discord.pluralkit.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.pluralkit.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.token",
		targetType: "channels.discord.token",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.token",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.discord.voice.tts.providers.*.apiKey",
		targetType: "channels.discord.voice.tts.providers.*.apiKey",
		configFile: "openclaw.json",
		pathPattern: "channels.discord.voice.tts.providers.*.apiKey",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true,
		providerIdPathSegmentIndex: 4
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "discord");
	if (!resolved) return;
	const { channel: discord, surface } = resolved;
	collectSimpleChannelFieldAssignments({
		channelKey: "discord",
		field: "token",
		channel: discord,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level Discord token.",
		accountInactiveReason: "Discord account is disabled."
	});
	collectNestedChannelFieldAssignments({
		channelKey: "discord",
		nestedKey: "pluralkit",
		field: "token",
		channel: discord,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActive: isBaseFieldActiveForChannelSurface(surface, "pluralkit") && isRecord(discord.pluralkit) && isEnabledFlag(discord.pluralkit),
		topInactiveReason: "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
		accountActive: ({ account, enabled }) => enabled && isRecord(account.pluralkit) && isEnabledFlag(account.pluralkit),
		accountInactiveReason: "Discord account is disabled or PluralKit is disabled for this account."
	});
	collectNestedChannelTtsAssignments({
		channelKey: "discord",
		nestedKey: "voice",
		channel: discord,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActive: isBaseFieldActiveForChannelSurface(surface, "voice") && isRecord(discord.voice) && isEnabledFlag(discord.voice),
		topInactiveReason: "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
		accountActive: ({ account, enabled }) => enabled && isRecord(account.voice) && isEnabledFlag(account.voice),
		accountInactiveReason: "Discord account is disabled or voice is disabled for this account."
	});
}
//#endregion
export { secretTargetRegistryEntries as n, collectRuntimeConfigAssignments as t };
