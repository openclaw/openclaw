import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./error-runtime-DGHc7DZw.js";
import { r as createFeishuClient } from "./client-Cl7PkrEA.js";
//#region extensions/feishu/src/async.ts
const RACE_TIMEOUT = Symbol("race-timeout");
const RACE_ABORT = Symbol("race-abort");
async function raceWithTimeoutAndAbort(promise, options = {}) {
	if (options.abortSignal?.aborted) return { status: "aborted" };
	if (options.timeoutMs === void 0 && !options.abortSignal) return {
		status: "resolved",
		value: await promise
	};
	let timeoutHandle;
	let abortHandler;
	const contenders = [promise];
	if (options.timeoutMs !== void 0) contenders.push(new Promise((resolve) => {
		timeoutHandle = setTimeout(() => resolve(RACE_TIMEOUT), options.timeoutMs);
	}));
	if (options.abortSignal) contenders.push(new Promise((resolve) => {
		abortHandler = () => resolve(RACE_ABORT);
		options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
	}));
	try {
		const result = await Promise.race(contenders);
		if (result === RACE_TIMEOUT) return { status: "timeout" };
		if (result === RACE_ABORT) return { status: "aborted" };
		return {
			status: "resolved",
			value: result
		};
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
	}
}
function waitForAbortableDelay(delayMs, abortSignal) {
	if (abortSignal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		let handleAbort;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (handleAbort) abortSignal?.removeEventListener("abort", handleAbort);
			resolve(value);
		};
		handleAbort = () => {
			finish(false);
		};
		abortSignal?.addEventListener("abort", handleAbort, { once: true });
		if (abortSignal?.aborted) {
			finish(false);
			return;
		}
		timer = setTimeout(() => finish(true), delayMs);
		timer.unref?.();
	});
}
//#endregion
//#region extensions/feishu/src/probe.ts
/** Cache probe results to reduce repeated health-check calls.
* Gateway health checks call probeFeishu() every minute; without caching this
* burns ~43,200 calls/month, easily exceeding Feishu's free-tier quota.
* Successful bot info is effectively static, while failures are cached briefly
* to avoid hammering the API during transient outages. */
const probeCache = /* @__PURE__ */ new Map();
const PROBE_SUCCESS_TTL_MS = 600 * 1e3;
const PROBE_ERROR_TTL_MS = 60 * 1e3;
const MAX_PROBE_CACHE_SIZE = 64;
const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 1e4;
function setCachedProbeResult(cacheKey, result, ttlMs) {
	probeCache.set(cacheKey, {
		result,
		expiresAt: Date.now() + ttlMs
	});
	if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
		const oldest = probeCache.keys().next().value;
		if (oldest !== void 0) probeCache.delete(oldest);
	}
	return result;
}
async function probeFeishu(creds, options = {}) {
	if (!creds?.appId || !creds?.appSecret) return {
		ok: false,
		error: "missing credentials (appId, appSecret)"
	};
	if (options.abortSignal?.aborted) return {
		ok: false,
		appId: creds.appId,
		error: "probe aborted"
	};
	const timeoutMs = options.timeoutMs ?? 1e4;
	const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
	const cached = probeCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.result;
	try {
		const responseResult = await raceWithTimeoutAndAbort(createFeishuClient(creds).request({
			method: "POST",
			url: "/open-apis/bot/v1/openclaw_bot/ping",
			data: { needBotInfo: true },
			timeout: timeoutMs
		}), {
			timeoutMs,
			abortSignal: options.abortSignal
		});
		if (responseResult.status === "aborted") return {
			ok: false,
			appId: creds.appId,
			error: "probe aborted"
		};
		if (responseResult.status === "timeout") return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: `probe timed out after ${timeoutMs}ms`
		}, PROBE_ERROR_TTL_MS);
		const response = responseResult.value;
		if (options.abortSignal?.aborted) return {
			ok: false,
			appId: creds.appId,
			error: "probe aborted"
		};
		if (response.code !== 0) return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: `API error: ${response.msg || `code ${response.code}`}`
		}, PROBE_ERROR_TTL_MS);
		const botInfo = response.data?.pingBotInfo;
		return setCachedProbeResult(cacheKey, {
			ok: true,
			appId: creds.appId,
			botName: botInfo?.botName,
			botOpenId: botInfo?.botID
		}, PROBE_SUCCESS_TTL_MS);
	} catch (err) {
		return setCachedProbeResult(cacheKey, {
			ok: false,
			appId: creds.appId,
			error: formatErrorMessage(err)
		}, PROBE_ERROR_TTL_MS);
	}
}
//#endregion
export { waitForAbortableDelay as i, probeFeishu as n, raceWithTimeoutAndAbort as r, FEISHU_PROBE_REQUEST_TIMEOUT_MS as t };
