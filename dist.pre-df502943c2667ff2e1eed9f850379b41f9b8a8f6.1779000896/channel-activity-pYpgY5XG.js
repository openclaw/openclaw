//#region src/infra/channel-activity.ts
const activity = /* @__PURE__ */ new Map();
function keyFor(channel, accountId) {
	return `${channel}:${accountId || "default"}`;
}
function ensureEntry(channel, accountId) {
	const key = keyFor(channel, accountId);
	const existing = activity.get(key);
	if (existing) return existing;
	const created = {
		inboundAt: null,
		outboundAt: null
	};
	activity.set(key, created);
	return created;
}
function recordChannelActivity(params) {
	const at = typeof params.at === "number" ? params.at : Date.now();
	const accountId = params.accountId?.trim() || "default";
	const entry = ensureEntry(params.channel, accountId);
	if (params.direction === "inbound") entry.inboundAt = at;
	if (params.direction === "outbound") entry.outboundAt = at;
}
function getChannelActivity(params) {
	const accountId = params.accountId?.trim() || "default";
	return activity.get(keyFor(params.channel, accountId)) ?? {
		inboundAt: null,
		outboundAt: null
	};
}
function resetChannelActivityForTest() {
	activity.clear();
}
//#endregion
export { recordChannelActivity as n, resetChannelActivityForTest as r, getChannelActivity as t };
