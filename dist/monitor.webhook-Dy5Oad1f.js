import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { f as resolveClientIp } from "./net-DCUMtgJy.js";
import "./security-runtime-CcSekjBd.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-DaB2erKZ.js";
import { a as createFixedWindowRateLimiter, o as createWebhookAnomalyTracker, r as WEBHOOK_RATE_LIMIT_DEFAULTS, t as WEBHOOK_ANOMALY_COUNTER_DEFAULTS } from "./webhook-ingress-R0qMwT4u.js";
import { r as applyBasicWebhookRequestGuards, s as readJsonWebhookBodyOrReject } from "./webhook-request-guards-iMi786D5.js";
import { l as withResolvedWebhookRequestPipeline, n as registerWebhookTargetWithPluginRoute, s as resolveWebhookTargetWithAuthOrRejectSync, t as registerWebhookTarget } from "./webhook-targets-gc0zD_lY.js";
import "./runtime-api-B6gWM_H9.js";
//#region extensions/zalo/src/monitor.webhook.ts
const ZALO_WEBHOOK_REPLAY_WINDOW_MS = 5 * 6e4;
const webhookTargets = /* @__PURE__ */ new Map();
const webhookRateLimiter = createFixedWindowRateLimiter({
	windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
	maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
	maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
});
const recentWebhookEvents = createClaimableDedupe({
	ttlMs: ZALO_WEBHOOK_REPLAY_WINDOW_MS,
	memoryMaxSize: 5e3
});
const webhookAnomalyTracker = createWebhookAnomalyTracker({
	maxTrackedKeys: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
	ttlMs: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
	logEvery: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery
});
function clearZaloWebhookSecurityStateForTest() {
	webhookRateLimiter.clear();
	recentWebhookEvents.clearMemory();
	webhookAnomalyTracker.clear();
}
function getZaloWebhookRateLimitStateSizeForTest() {
	return webhookRateLimiter.size();
}
function getZaloWebhookStatusCounterSizeForTest() {
	return webhookAnomalyTracker.size();
}
function timingSafeEquals(left, right) {
	return safeEqualSecret(left, right);
}
function buildReplayEventCacheKey(target, update) {
	const messageId = update.message?.message_id;
	if (!messageId) return null;
	const chatId = update.message?.chat?.id ?? "";
	const senderId = update.message?.from?.id ?? "";
	return JSON.stringify([
		target.path,
		target.account.accountId,
		update.event_name,
		chatId,
		senderId,
		messageId
	]);
}
var ZaloRetryableWebhookError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "ZaloRetryableWebhookError";
	}
};
async function processZaloReplayGuardedUpdate(params) {
	const replayEventKey = buildReplayEventCacheKey(params.target, params.update);
	if (replayEventKey) {
		if ((await recentWebhookEvents.claim(replayEventKey, { now: params.nowMs })).kind !== "claimed") return "duplicate";
	}
	params.target.statusSink?.({ lastInboundAt: Date.now() });
	try {
		await params.processUpdate({
			update: params.update,
			target: params.target
		});
		if (replayEventKey) await recentWebhookEvents.commit(replayEventKey);
		return "processed";
	} catch (error) {
		if (replayEventKey) if (error instanceof ZaloRetryableWebhookError) recentWebhookEvents.release(replayEventKey, { error });
		else await recentWebhookEvents.commit(replayEventKey);
		throw error;
	}
}
function recordWebhookStatus(runtime, path, statusCode) {
	webhookAnomalyTracker.record({
		key: `${path}:${statusCode}`,
		statusCode,
		log: runtime?.log,
		message: (count) => `[zalo] webhook anomaly path=${path} status=${statusCode} count=${String(count)}`
	});
}
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
function registerZaloWebhookTarget(target, opts) {
	if (opts?.route) return registerWebhookTargetWithPluginRoute({
		targetsByPath: webhookTargets,
		target,
		route: opts.route,
		onLastPathTargetRemoved: opts.onLastPathTargetRemoved
	}).unregister;
	return registerWebhookTarget(webhookTargets, target, opts).unregister;
}
async function handleZaloWebhookRequest(req, res, processUpdate) {
	return await withResolvedWebhookRequestPipeline({
		req,
		res,
		targetsByPath: webhookTargets,
		allowMethods: ["POST"],
		handle: async ({ targets, path }) => {
			const trustedProxies = targets[0]?.config.gateway?.trustedProxies;
			const allowRealIpFallback = targets[0]?.config.gateway?.allowRealIpFallback === true;
			const rateLimitKey = `${path}:${resolveClientIp({
				remoteAddr: req.socket.remoteAddress,
				forwardedFor: headerValue(req.headers["x-forwarded-for"]),
				realIp: headerValue(req.headers["x-real-ip"]),
				trustedProxies,
				allowRealIpFallback
			}) ?? req.socket.remoteAddress ?? "unknown"}`;
			const nowMs = Date.now();
			if (!applyBasicWebhookRequestGuards({
				req,
				res,
				rateLimiter: webhookRateLimiter,
				rateLimitKey,
				nowMs
			})) {
				recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
				return true;
			}
			const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
			const target = resolveWebhookTargetWithAuthOrRejectSync({
				targets,
				res,
				isMatch: (entry) => timingSafeEquals(entry.secret, headerToken)
			});
			if (!target) {
				recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
				return true;
			}
			if (!applyBasicWebhookRequestGuards({
				req,
				res,
				requireJsonContentType: true
			})) {
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			const body = await readJsonWebhookBodyOrReject({
				req,
				res,
				maxBytes: 1024 * 1024,
				timeoutMs: 3e4,
				emptyObjectOnEmpty: false,
				invalidJsonMessage: "Bad Request"
			});
			if (!body.ok) {
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			const raw = body.value;
			const record = raw && typeof raw === "object" ? raw : null;
			const update = record && record.ok === true && record.result ? record.result : record ?? void 0;
			if (!update?.event_name) {
				res.statusCode = 400;
				res.end("Bad Request");
				recordWebhookStatus(target.runtime, path, res.statusCode);
				return true;
			}
			processZaloReplayGuardedUpdate({
				target,
				update,
				processUpdate,
				nowMs
			}).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] Zalo webhook failed: ${String(err)}`);
			});
			res.statusCode = 200;
			res.end("ok");
			return true;
		}
	});
}
//#endregion
export { ZaloRetryableWebhookError, clearZaloWebhookSecurityStateForTest, getZaloWebhookRateLimitStateSizeForTest, getZaloWebhookStatusCounterSizeForTest, handleZaloWebhookRequest, processZaloReplayGuardedUpdate, registerZaloWebhookTarget };
