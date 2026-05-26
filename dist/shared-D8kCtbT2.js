import { c as shouldUseEnvHttpProxyForUrl } from "./proxy-env-Cs0G_0hd.js";
import { c as resolveProviderRequestPolicyConfig, n as buildProviderRequestDispatcherPolicy } from "./provider-request-config-DxK6PUHR.js";
import { r as fetchWithTimeout } from "./fetch-timeout-CptH2le9.js";
import { n as fetchWithSsrFGuard, t as GUARDED_FETCH_MODE } from "./fetch-guard-BEAbHb5H.js";
import { t as executeProviderOperationWithRetry } from "./operation-retry-DSyuuv9E.js";
import { o as createProviderHttpError, p as readProviderJsonObjectResponse, r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import path from "node:path";
//#region src/media-understanding/shared.ts
const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 6e4;
const MAX_AUDIT_CONTEXT_CHARS = 80;
function resolveAudioTranscriptionUploadFileName(fileName, mime) {
	const trimmed = fileName?.trim();
	const baseName = trimmed ? path.basename(trimmed) : "audio";
	const lowerMime = mime?.trim().toLowerCase();
	if (/\.aac$/i.test(baseName)) return `${baseName.slice(0, -4) || "audio"}.m4a`;
	if (!path.extname(baseName) && lowerMime === "audio/aac") return `${baseName || "audio"}.m4a`;
	return baseName;
}
function buildAudioTranscriptionFormData(params) {
	const form = new FormData();
	const bytes = new Uint8Array(params.buffer);
	const blob = new Blob([bytes], { type: params.mime ?? "application/octet-stream" });
	form.append("file", blob, resolveAudioTranscriptionUploadFileName(params.fileName, params.mime));
	for (const [name, value] of Object.entries(params.fields ?? {})) {
		const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
		if (text) form.append(name, text);
	}
	return form;
}
function createProviderOperationDeadline(params) {
	if (typeof params.timeoutMs !== "number" || !Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) return { label: params.label };
	const timeoutMs = Math.floor(params.timeoutMs);
	return {
		deadlineAtMs: Date.now() + timeoutMs,
		label: params.label,
		timeoutMs
	};
}
function resolveProviderOperationTimeoutMs(params) {
	const deadlineAtMs = params.deadline.deadlineAtMs;
	if (typeof deadlineAtMs !== "number") return params.defaultTimeoutMs;
	const remainingMs = deadlineAtMs - Date.now();
	if (remainingMs <= 0) throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
	return Math.max(1, Math.min(params.defaultTimeoutMs, remainingMs));
}
function createProviderOperationTimeoutResolver(params) {
	return () => resolveProviderOperationTimeoutMs(params);
}
async function waitProviderOperationPollInterval(params) {
	const deadlineAtMs = params.deadline.deadlineAtMs;
	if (typeof deadlineAtMs !== "number") {
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
		return;
	}
	const remainingMs = deadlineAtMs - Date.now();
	if (remainingMs <= 0) throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
	await new Promise((resolve) => setTimeout(resolve, Math.min(params.pollIntervalMs, remainingMs)));
}
async function pollProviderOperationJson(params) {
	for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
		const init = {
			method: "GET",
			headers: params.headers
		};
		const timeoutMs = createProviderOperationTimeoutResolver({
			deadline: params.deadline,
			defaultTimeoutMs: params.defaultTimeoutMs
		});
		const guardedOptions = resolveGuardedRequestOptions(params);
		const payload = guardedOptions ? await (async () => {
			const result = await fetchGuardedProviderOperationResponse({
				stage: "poll",
				url: params.url,
				init,
				timeoutMs,
				fetchFn: params.fetchFn,
				requestFailedMessage: params.requestFailedMessage,
				guardedOptions
			});
			try {
				return await readProviderJsonObjectResponse(result.response, params.requestFailedMessage);
			} finally {
				await result.release();
			}
		})() : await readProviderJsonObjectResponse(await fetchProviderOperationResponse({
			stage: "poll",
			url: params.url,
			init,
			timeoutMs,
			fetchFn: params.fetchFn,
			requestFailedMessage: params.requestFailedMessage
		}), params.requestFailedMessage);
		if (params.isComplete(payload)) return payload;
		const failureMessage = params.getFailureMessage?.(payload);
		if (failureMessage) throw new Error(failureMessage);
		await waitProviderOperationPollInterval({
			deadline: params.deadline,
			pollIntervalMs: params.pollIntervalMs
		});
	}
	throw new Error(params.timeoutMessage);
}
async function fetchProviderOperationResponse(params) {
	return await executeProviderOperationWithRetry({
		provider: params.provider ?? "provider-http",
		stage: params.stage,
		retry: params.retry,
		operation: async () => {
			const response = await fetchWithTimeout(params.url, params.init ?? {}, resolveProviderOperationRequestTimeoutMs(params.timeoutMs), params.fetchFn);
			if (params.requestFailedMessage) await assertOkOrThrowHttpError(response, params.requestFailedMessage);
			return response;
		}
	});
}
async function fetchProviderDownloadResponse(params) {
	return await fetchProviderOperationResponse({
		stage: "download",
		url: params.url,
		init: params.init,
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		provider: params.provider,
		requestFailedMessage: params.requestFailedMessage,
		retry: params.retry
	});
}
function resolveProviderOperationRequestTimeoutMs(timeoutMs) {
	const resolved = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
	if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
	return resolved;
}
function resolveGuardedHttpTimeoutMs(timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
	return timeoutMs;
}
function sanitizeAuditContext(auditContext) {
	const cleaned = auditContext?.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return;
	return cleaned.slice(0, MAX_AUDIT_CONTEXT_CHARS);
}
function resolveProviderHttpRequestConfig(params) {
	const requestConfig = resolveProviderRequestPolicyConfig({
		provider: params.provider ?? "",
		baseUrl: params.baseUrl,
		defaultBaseUrl: params.defaultBaseUrl,
		capability: params.capability ?? "other",
		transport: params.transport ?? "http",
		callerHeaders: params.headers ? Object.fromEntries(new Headers(params.headers).entries()) : void 0,
		providerHeaders: params.defaultHeaders,
		precedence: "caller-wins",
		allowPrivateNetwork: params.allowPrivateNetwork,
		api: params.api,
		request: params.request
	});
	const headers = new Headers(requestConfig.headers);
	if (!requestConfig.baseUrl) throw new Error("Missing baseUrl: provide baseUrl or defaultBaseUrl");
	return {
		baseUrl: requestConfig.baseUrl,
		allowPrivateNetwork: requestConfig.allowPrivateNetwork,
		headers,
		dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
		requestConfig
	};
}
/**
* Decide whether to auto-upgrade a provider HTTP request into
* `TRUSTED_ENV_PROXY` mode based on the runtime environment.
*
* This is gated conservatively to avoid the SSRF bypasses the initial
* auto-upgrade path exposed (see openclaw#64974 review threads):
*
* 1. If the caller supplied an explicit `dispatcherPolicy` — custom proxy URL,
*    `proxyTls`, or `connect` options — do NOT override it. Trusted-env mode
*    builds an `EnvHttpProxyAgent` that would silently drop those overrides,
*    breaking enterprise proxy/mTLS configs.
*
* 2. Only auto-upgrade when `HTTP_PROXY` or `HTTPS_PROXY` (lower- or
*    upper-case) is configured for the target protocol. `ALL_PROXY` is
*    explicitly ignored by `EnvHttpProxyAgent`, so counting it would
*    auto-upgrade requests that then make direct connections while skipping
*    pinned-DNS/SSRF hostname checks.
*
* 3. If `NO_PROXY` would bypass the proxy for this target, do NOT auto-upgrade.
*    `EnvHttpProxyAgent` makes direct connections for `NO_PROXY` matches, but
*    in `TRUSTED_ENV_PROXY` mode `fetchWithSsrFGuard` skips
*    `resolvePinnedHostnameWithPolicy` — so those direct connections would
*    bypass SSRF protection. Keep strict mode for `NO_PROXY` matches.
*/
function shouldAutoUpgradeToTrustedEnvProxy(params) {
	if (params.dispatcherPolicy) return false;
	return shouldUseEnvHttpProxyForUrl(params.url);
}
async function fetchWithTimeoutGuarded(url, init, timeoutMs, fetchFn, options) {
	const resolvedMode = options?.mode ?? (shouldAutoUpgradeToTrustedEnvProxy({
		url,
		dispatcherPolicy: options?.dispatcherPolicy
	}) ? GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY : void 0);
	return await fetchWithSsrFGuard({
		url,
		fetchImpl: fetchFn,
		init,
		timeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),
		policy: options?.ssrfPolicy,
		lookupFn: options?.lookupFn,
		pinDns: options?.pinDns,
		dispatcherPolicy: options?.dispatcherPolicy,
		auditContext: sanitizeAuditContext(options?.auditContext),
		...resolvedMode ? { mode: resolvedMode } : {}
	});
}
function mergeGuardedRequestSsrfPolicy(params) {
	if (!params.ssrfPolicy) return params.allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0;
	if (!params.allowPrivateNetwork) return params.ssrfPolicy;
	return {
		...params.ssrfPolicy,
		allowPrivateNetwork: true
	};
}
function resolveGuardedRequestOptions(params) {
	if (!params.allowPrivateNetwork && !params.ssrfPolicy && !params.dispatcherPolicy && params.pinDns === void 0 && !params.auditContext && params.mode === void 0) return;
	const ssrfPolicy = mergeGuardedRequestSsrfPolicy(params);
	return {
		...ssrfPolicy ? { ssrfPolicy } : {},
		...params.pinDns !== void 0 ? { pinDns: params.pinDns } : {},
		...params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {},
		...params.auditContext ? { auditContext: params.auditContext } : {},
		...params.mode !== void 0 ? { mode: params.mode } : {}
	};
}
async function fetchGuardedProviderOperationResponse(params) {
	return await executeProviderOperationWithRetry({
		provider: params.provider ?? "provider-http",
		stage: params.stage,
		retry: params.retry,
		operation: async () => {
			const result = await fetchWithTimeoutGuarded(params.url, params.init, resolveProviderOperationRequestTimeoutMs(params.timeoutMs), params.fetchFn, params.guardedOptions);
			try {
				if (params.requestFailedMessage) await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
				return result;
			} catch (error) {
				await result.release();
				throw error;
			}
		}
	});
}
async function postTranscriptionRequest(params) {
	return await postGuardedRequest({
		url: params.url,
		init: {
			method: "POST",
			headers: params.headers,
			body: params.body
		},
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		guardedOptions: resolveGuardedRequestOptions(params),
		retryStage: params.retryStage,
		retry: params.retry
	});
}
async function postGuardedRequest(params) {
	const operation = async () => {
		const result = await fetchWithTimeoutGuarded(params.url, params.init, params.timeoutMs, params.fetchFn, params.guardedOptions);
		if (params.retryStage && isTransientProviderHttpStatus(result.response.status)) try {
			throw await createProviderHttpError(result.response, "provider POST request failed", { statusPrefix: "HTTP " });
		} finally {
			await result.release();
		}
		return result;
	};
	if (!params.retryStage) return await operation();
	return await executeProviderOperationWithRetry({
		provider: "provider-http",
		stage: params.retryStage,
		retry: params.retry,
		operation
	});
}
function isTransientProviderHttpStatus(status) {
	return status === 500 || status === 502 || status === 503 || status === 504;
}
async function postJsonRequest(params) {
	return await postGuardedRequest({
		url: params.url,
		init: {
			method: "POST",
			headers: params.headers,
			body: JSON.stringify(params.body)
		},
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		guardedOptions: resolveGuardedRequestOptions(params),
		retryStage: params.retryStage,
		retry: params.retry
	});
}
async function postMultipartRequest(params) {
	return await postGuardedRequest({
		url: params.url,
		init: {
			method: "POST",
			headers: params.headers,
			body: params.body
		},
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		guardedOptions: resolveGuardedRequestOptions(params),
		retryStage: params.retryStage,
		retry: params.retry
	});
}
function requireTranscriptionText(value, missingMessage) {
	const text = value?.trim();
	if (!text) throw new Error(missingMessage);
	return text;
}
//#endregion
export { fetchProviderOperationResponse as a, postJsonRequest as c, requireTranscriptionText as d, resolveAudioTranscriptionUploadFileName as f, waitProviderOperationPollInterval as h, fetchProviderDownloadResponse as i, postMultipartRequest as l, resolveProviderOperationTimeoutMs as m, createProviderOperationDeadline as n, fetchWithTimeoutGuarded as o, resolveProviderHttpRequestConfig as p, createProviderOperationTimeoutResolver as r, pollProviderOperationJson as s, buildAudioTranscriptionFormData as t, postTranscriptionRequest as u };
