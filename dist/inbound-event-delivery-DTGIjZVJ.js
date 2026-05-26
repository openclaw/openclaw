//#region extensions/discord/src/inbound-event-delivery.ts
const DISCORD_INBOUND_EVENT_DELIVERY_KEY = "__openclawInboundEventDelivery";
const registry = /* @__PURE__ */ new Map();
function normalizeDiscordDeliveryTarget(value) {
	return value.trim().replace(/^discord:/iu, "").replace(/^channel:/iu, "").toLowerCase();
}
function resolveDiscordInboundEventDeliveryCorrelationKey(sessionKey, inboundEventKind) {
	const key = sessionKey?.trim();
	if (!key) return;
	return inboundEventKind === "room_event" ? `${key}:room_event` : key;
}
function beginDiscordInboundEventDeliveryCorrelation(sessionKey, event, options) {
	const key = resolveDiscordInboundEventDeliveryCorrelationKey(sessionKey, options?.inboundEventKind);
	if (!key) return () => {};
	registry.set(key, event);
	return () => {
		if (registry.get(key) === event) registry.delete(key);
	};
}
function notifyDiscordInboundEventOutboundSuccess(params) {
	const key = resolveDiscordInboundEventDeliveryCorrelationKey(params.sessionKey, params.inboundEventKind);
	if (!key) return;
	const event = registry.get(key);
	if (!event || normalizeDiscordDeliveryTarget(event.outboundTo) !== normalizeDiscordDeliveryTarget(params.to)) return;
	if (event.outboundAccountId && params.accountId && params.accountId !== event.outboundAccountId) return;
	registry.delete(key);
	event.markInboundEventDelivered();
}
function readRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function withDiscordInboundEventDeliveryMetadata(payload, params) {
	const sessionKey = params.sessionKey?.trim();
	if (!sessionKey || params.inboundEventKind !== "room_event") return payload;
	const channelData = readRecord(payload.channelData) ?? {};
	const discordData = readRecord(channelData.discord) ?? {};
	return {
		...payload,
		channelData: {
			...channelData,
			discord: {
				...discordData,
				[DISCORD_INBOUND_EVENT_DELIVERY_KEY]: {
					sessionKey,
					inboundEventKind: params.inboundEventKind
				}
			}
		}
	};
}
function notifyDiscordInboundEventOutboundPayloadSuccess(params) {
	const metadata = readRecord(readRecord(readRecord(params.payload.channelData)?.discord)?.[DISCORD_INBOUND_EVENT_DELIVERY_KEY]);
	if (!metadata) return;
	notifyDiscordInboundEventOutboundSuccess({
		sessionKey: readString(metadata.sessionKey),
		inboundEventKind: readString(metadata.inboundEventKind),
		to: params.to,
		accountId: params.accountId
	});
}
//#endregion
export { withDiscordInboundEventDeliveryMetadata as i, notifyDiscordInboundEventOutboundPayloadSuccess as n, notifyDiscordInboundEventOutboundSuccess as r, beginDiscordInboundEventDeliveryCorrelation as t };
