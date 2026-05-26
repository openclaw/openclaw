import { c as isRecord } from "./utils-sBTEdeml.js";
import { o as isEnabledFlag } from "./runtime-shared-CPFXAPqc.js";
import { a as getChannelSurface, n as collectNestedChannelFieldAssignments, r as collectSimpleChannelFieldAssignments, s as isBaseFieldActiveForChannelSurface } from "./channel-secret-basic-runtime-CU0qW-Ow.js";
import "./channel-secret-basic-runtime-eKiftYvE.js";
//#region extensions/irc/src/secret-contract.ts
const secretTargetRegistryEntries = [
	{
		id: "channels.irc.accounts.*.nickserv.password",
		targetType: "channels.irc.accounts.*.nickserv.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.accounts.*.nickserv.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.accounts.*.password",
		targetType: "channels.irc.accounts.*.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.accounts.*.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.nickserv.password",
		targetType: "channels.irc.nickserv.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.nickserv.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	},
	{
		id: "channels.irc.password",
		targetType: "channels.irc.password",
		configFile: "openclaw.json",
		pathPattern: "channels.irc.password",
		secretShape: "secret_input",
		expectedResolvedValue: "string",
		includeInPlan: true,
		includeInConfigure: true,
		includeInAudit: true
	}
];
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "irc");
	if (!resolved) return;
	const { channel: irc, surface } = resolved;
	collectSimpleChannelFieldAssignments({
		channelKey: "irc",
		field: "password",
		channel: irc,
		surface,
		defaults: params.defaults,
		context: params.context,
		topInactiveReason: "no enabled account inherits this top-level IRC password.",
		accountInactiveReason: "IRC account is disabled."
	});
	collectNestedChannelFieldAssignments({
		channelKey: "irc",
		nestedKey: "nickserv",
		field: "password",
		channel: irc,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActive: isBaseFieldActiveForChannelSurface(surface, "nickserv") && isRecord(irc.nickserv) && isEnabledFlag(irc.nickserv),
		topInactiveReason: "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
		accountActive: ({ account, enabled }) => enabled && isRecord(account.nickserv) && isEnabledFlag(account.nickserv),
		accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
