import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { t as normalizeAnyChannelId } from "./registry-normalize-CWTP5axf.js";
//#region src/utils/message-channel-constants.ts
const INTERNAL_MESSAGE_CHANNEL = "webchat";
const INTERNAL_NON_DELIVERY_CHANNELS = [
	"heartbeat",
	"cron",
	"webhook",
	"voice"
];
function isInternalNonDeliveryChannel(value) {
	return INTERNAL_NON_DELIVERY_CHANNELS.includes(value);
}
//#endregion
//#region src/utils/message-channel-core.ts
function normalizeMessageChannel(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) return;
	if (normalized === "webchat") return INTERNAL_MESSAGE_CHANNEL;
	const builtIn = normalizeChatChannelId(normalized);
	if (builtIn) return builtIn;
	return normalizeAnyChannelId(normalized) ?? normalized;
}
function isDeliverableMessageChannel(value) {
	const normalized = normalizeMessageChannel(value);
	return normalized !== void 0 && normalized !== "webchat" && normalized === value;
}
//#endregion
export { isInternalNonDeliveryChannel as i, normalizeMessageChannel as n, INTERNAL_MESSAGE_CHANNEL as r, isDeliverableMessageChannel as t };
