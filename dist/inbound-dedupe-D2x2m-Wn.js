import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { n as resolveGlobalSingleton } from "./global-singleton-B2nbp4Tq.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import "./globals-CouSpJO4.js";
import { n as resolveGlobalDedupeCache } from "./dedupe-Cby1DfpJ.js";
import { n as channelRouteDedupeKey } from "./channel-route-jaZFObQA.js";
//#region src/auto-reply/reply/inbound-dedupe.ts
const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 6e4;
const DEFAULT_INBOUND_DEDUPE_MAX = 5e3;
/**
* Keep inbound dedupe shared across bundled chunks so the same provider
* message cannot bypass dedupe by entering through a different chunk copy.
*/
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeInflight");
const inboundDedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
	ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
	maxSize: DEFAULT_INBOUND_DEDUPE_MAX
});
const inboundDedupeInFlight = resolveGlobalSingleton(INBOUND_DEDUPE_INFLIGHT_KEY, () => /* @__PURE__ */ new Set());
const resolveInboundPeerId = (ctx) => ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;
function resolveInboundDedupeSessionScope(ctx) {
	const sessionKey = (ctx.CommandSource === "native" ? normalizeOptionalString(ctx.CommandTargetSessionKey) : void 0) || normalizeOptionalString(ctx.SessionKey) || "";
	if (!sessionKey) return "";
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return sessionKey;
	return `agent:${parsed.agentId}`;
}
function buildInboundDedupeKey(ctx) {
	const provider = normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface) || "";
	const messageId = normalizeOptionalString(ctx.MessageSid);
	if (!provider || !messageId) return null;
	const peerId = resolveInboundPeerId(ctx);
	if (!peerId) return null;
	const sessionScope = resolveInboundDedupeSessionScope(ctx);
	const routeKey = channelRouteDedupeKey({
		channel: provider,
		to: peerId,
		accountId: normalizeOptionalString(ctx.AccountId) ?? "",
		threadId: ctx.MessageThreadId
	});
	return JSON.stringify([
		sessionScope,
		routeKey,
		messageId
	]);
}
function claimInboundDedupe(ctx, opts) {
	const key = buildInboundDedupeKey(ctx);
	if (!key) return { status: "invalid" };
	if ((opts?.cache ?? inboundDedupeCache).peek(key, opts?.now)) return {
		status: "duplicate",
		key
	};
	const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
	if (inFlight.has(key)) return {
		status: "inflight",
		key
	};
	inFlight.add(key);
	return {
		status: "claimed",
		key
	};
}
function commitInboundDedupe(key, opts) {
	(opts?.cache ?? inboundDedupeCache).check(key, opts?.now);
	(opts?.inFlight ?? inboundDedupeInFlight).delete(key);
}
function releaseInboundDedupe(key, opts) {
	(opts?.inFlight ?? inboundDedupeInFlight).delete(key);
}
function resetInboundDedupe() {
	inboundDedupeCache.clear();
	inboundDedupeInFlight.clear();
}
//#endregion
export { resetInboundDedupe as i, commitInboundDedupe as n, releaseInboundDedupe as r, claimInboundDedupe as t };
