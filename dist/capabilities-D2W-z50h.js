//#region src/channels/message/capabilities.ts
function hasMediaPayload(payload) {
	if (payload.mediaUrl?.trim()) return true;
	return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => typeof url === "string" && url.trim().length > 0);
}
function setRequired(requirements, capability, required) {
	if (required === true) requirements[capability] = true;
}
function deriveDurableFinalDeliveryRequirements(params) {
	const requirements = {};
	setRequired(requirements, "text", true);
	setRequired(requirements, "media", hasMediaPayload(params.payload));
	setRequired(requirements, "replyTo", params.replyToId != null || params.payload.replyToId != null);
	setRequired(requirements, "thread", params.threadId != null);
	setRequired(requirements, "silent", params.silent);
	setRequired(requirements, "messageSendingHooks", params.messageSendingHooks !== false);
	setRequired(requirements, "payload", params.payloadTransport);
	setRequired(requirements, "batch", params.batch);
	setRequired(requirements, "reconcileUnknownSend", params.reconcileUnknownSend);
	setRequired(requirements, "afterSendSuccess", params.afterSendSuccess);
	setRequired(requirements, "afterCommit", params.afterCommit);
	for (const [capability, required] of Object.entries(params.extraCapabilities ?? {})) setRequired(requirements, capability, required);
	return requirements;
}
//#endregion
export { deriveDurableFinalDeliveryRequirements as t };
