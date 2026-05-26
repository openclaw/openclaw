import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
//#region src/cron/isolated-agent/model-preflight.runtime.ts
const PREFLIGHT_CACHE_TTL_MS = 5 * 6e4;
const PREFLIGHT_TIMEOUT_MS = 2500;
const preflightCache = /* @__PURE__ */ new Map();
function resolveProviderConfig(cfg, provider) {
	const providers = cfg.models?.providers;
	if (!providers) return;
	const direct = providers[provider];
	if (direct) return direct;
	const normalized = normalizeProviderId(provider);
	return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}
function normalizeBaseUrl(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : void 0;
}
function normalizeProbeApi(providerConfig) {
	const api = normalizeLowercaseStringOrEmpty(providerConfig.api);
	return api === "ollama" || api === "openai-completions" ? api : void 0;
}
function isPrivateIpv4Host(host) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
	const octets = host.split(".").map((part) => Number.parseInt(part, 10));
	if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = octets;
	return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function isLocalProviderBaseUrl(baseUrl) {
	try {
		let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
		if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::ffff:7f00:1" || host === "::ffff:127.0.0.1" || host.endsWith(".local") || isPrivateIpv4Host(host);
	} catch {
		return false;
	}
}
function buildProbeUrl(api, baseUrl) {
	if (api === "ollama") return `${baseUrl}/api/tags`;
	return `${baseUrl}/models`;
}
function buildLocalProviderSsrFPolicy(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return {
			hostnameAllowlist: [parsed.hostname],
			allowPrivateNetwork: true
		};
	} catch {
		return;
	}
}
function formatUnavailableReason(params) {
	return [
		`Agent cron job uses ${params.provider}/${params.model} but the local provider endpoint is not reachable at ${params.baseUrl}.`,
		`Skipping this cron run; OpenClaw will retry the provider preflight on a later scheduled run.`,
		`Last error: ${String(params.error)}`
	].join(" ");
}
function buildUnavailableResult(params) {
	return {
		status: "unavailable",
		provider: params.provider,
		model: params.model,
		baseUrl: params.baseUrl,
		retryAfterMs: PREFLIGHT_CACHE_TTL_MS,
		reason: formatUnavailableReason({
			provider: params.provider,
			model: params.model,
			baseUrl: params.baseUrl,
			error: params.error
		})
	};
}
async function probeLocalProviderEndpoint(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: buildProbeUrl(params.api, params.baseUrl),
		init: { method: "GET" },
		policy: buildLocalProviderSsrFPolicy(params.baseUrl),
		timeoutMs: PREFLIGHT_TIMEOUT_MS,
		auditContext: "cron-model-provider-preflight"
	});
	try {
		response.status;
	} finally {
		await release();
	}
}
async function preflightCronModelProvider(params) {
	const providerConfig = resolveProviderConfig(params.cfg, params.provider);
	if (!providerConfig) return { status: "available" };
	const baseUrl = normalizeBaseUrl(providerConfig.baseUrl);
	const api = normalizeProbeApi(providerConfig);
	if (!baseUrl || !api || !isLocalProviderBaseUrl(baseUrl)) return { status: "available" };
	const nowMs = params.nowMs ?? Date.now();
	const cacheKey = `${api}\0${baseUrl}`;
	const cached = preflightCache.get(cacheKey);
	if (cached && nowMs - cached.checkedAtMs < PREFLIGHT_CACHE_TTL_MS) {
		if (cached.result.status === "available") return { status: "available" };
		return buildUnavailableResult({
			provider: params.provider,
			model: params.model,
			baseUrl,
			error: cached.result.error
		});
	}
	let result;
	try {
		await probeLocalProviderEndpoint({
			api,
			baseUrl
		});
		result = { status: "available" };
	} catch (error) {
		result = {
			status: "unavailable",
			error
		};
	}
	preflightCache.set(cacheKey, {
		checkedAtMs: nowMs,
		result
	});
	if (result.status === "available") return { status: "available" };
	return buildUnavailableResult({
		provider: params.provider,
		model: params.model,
		baseUrl,
		error: result.error
	});
}
function resetCronModelProviderPreflightCacheForTest() {
	preflightCache.clear();
}
//#endregion
export { preflightCronModelProvider, resetCronModelProviderPreflightCacheForTest };
