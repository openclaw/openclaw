import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as resolveLegacyOutboundSendDepKeys } from "./send-deps-B-rmeTVl.js";
//#region src/cli/outbound-send-mapping.ts
/**
* CLI-internal send function sources, keyed by channel ID.
* Each value is a lazily-loaded send function for that channel.
*/
const CLI_OUTBOUND_SEND_FACTORY = Symbol.for("openclaw.cliOutboundSendFactory");
function normalizeLegacyChannelStem(raw) {
	return normalizeLowercaseStringOrEmpty(raw.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").trim()).replace(/-/g, "");
}
function resolveChannelIdFromLegacySourceKey(key) {
	const match = key.match(/^sendMessage(.+)$/);
	if (!match) return;
	return normalizeLegacyChannelStem(match[1] ?? "") || void 0;
}
function resolveChannelIdFromLegacyOutboundKey(key) {
	const match = key.match(/^send(.+)$/);
	if (!match) return;
	return normalizeLegacyChannelStem(match[1] ?? "") || void 0;
}
/**
* Pass CLI send sources through as-is — both CliOutboundSendSource and
* OutboundSendDeps are now channel-ID-keyed records.
*/
function createOutboundSendDepsFromCliSource(deps) {
	const outbound = { ...deps };
	const sendFactory = deps[CLI_OUTBOUND_SEND_FACTORY];
	for (const legacySourceKey of Object.keys(deps)) {
		const channelId = resolveChannelIdFromLegacySourceKey(legacySourceKey);
		if (!channelId) continue;
		const sourceValue = deps[legacySourceKey];
		if (sourceValue !== void 0 && outbound[channelId] === void 0) outbound[channelId] = sourceValue;
	}
	for (const channelId of Object.keys(outbound)) {
		const sourceValue = outbound[channelId];
		if (sourceValue === void 0) continue;
		for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) if (outbound[legacyDepKey] === void 0) outbound[legacyDepKey] = sourceValue;
	}
	if (!sendFactory) return outbound;
	const resolveFactoryValue = (key) => {
		const channelId = outbound[key] === void 0 ? resolveChannelIdFromLegacyOutboundKey(key) ?? key : key;
		if (!channelId || channelId === "then" || channelId === "toJSON") return;
		const value = sendFactory(channelId);
		if (value !== void 0) {
			outbound[channelId] = value;
			for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) outbound[legacyDepKey] ??= value;
		}
		return value;
	};
	return new Proxy(outbound, { get(target, property, receiver) {
		if (typeof property !== "string") return Reflect.get(target, property, receiver);
		const existing = Reflect.get(target, property, receiver);
		if (existing !== void 0) return existing;
		return resolveFactoryValue(property);
	} });
}
//#endregion
export { createOutboundSendDepsFromCliSource as n, CLI_OUTBOUND_SEND_FACTORY as t };
