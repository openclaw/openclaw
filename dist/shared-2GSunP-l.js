import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { r as fetchWithTimeout } from "./fetch-timeout-CptH2le9.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { h as waitProviderOperationPollInterval, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/vydra/shared.ts
const DEFAULT_VYDRA_BASE_URL = "https://www.vydra.ai/api/v1";
const DEFAULT_VYDRA_IMAGE_MODEL = "grok-imagine";
const DEFAULT_VYDRA_VIDEO_MODEL = "veo3";
const DEFAULT_VYDRA_SPEECH_MODEL = "elevenlabs/tts";
const DEFAULT_VYDRA_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_HTTP_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_ATTEMPTS = 120;
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function addUrlValue(value, urls) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^https?:\/\//iu.test(trimmed)) urls.add(trimmed);
		return;
	}
	if (Array.isArray(value)) for (const entry of value) addUrlValue(entry, urls);
}
const trimToUndefined = normalizeOptionalString;
function normalizeVydraBaseUrl(value) {
	const fallback = DEFAULT_VYDRA_BASE_URL;
	const trimmed = trimToUndefined(value);
	if (!trimmed) return fallback;
	try {
		const url = new URL(trimmed);
		if (url.hostname === "vydra.ai") url.hostname = "www.vydra.ai";
		const pathname = url.pathname.replace(/\/+$/u, "");
		if (!pathname) url.pathname = "/api/v1";
		else url.pathname = pathname;
		return url.toString().replace(/\/$/u, "");
	} catch {
		return fallback;
	}
}
function resolveVydraBaseUrlFromConfig(cfg) {
	return normalizeVydraBaseUrl(trimToUndefined(asObject(asObject(asObject(asObject(cfg)?.models)?.providers)?.vydra)?.baseUrl));
}
async function resolveVydraRequestContext(params) {
	const auth = await resolveApiKeyForProvider({
		provider: "vydra",
		cfg: params.cfg,
		agentDir: params.agentDir,
		store: params.authStore
	});
	if (!auth.apiKey) throw new Error("Vydra API key missing");
	const fetchFn = fetch;
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: resolveVydraBaseUrlFromConfig(params.cfg),
		defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
		allowPrivateNetwork: false,
		defaultHeaders: {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json"
		},
		provider: "vydra",
		capability: params.capability,
		transport: "http"
	});
	return {
		fetchFn,
		baseUrl,
		allowPrivateNetwork,
		headers,
		dispatcherPolicy
	};
}
function resolveVydraResponseJobId(payload) {
	const object = asObject(payload);
	return trimToUndefined(object?.jobId) ?? trimToUndefined(object?.id);
}
function resolveVydraResponseStatus(payload) {
	return normalizeOptionalLowercaseString(trimToUndefined(asObject(payload)?.status));
}
function resolveVydraErrorMessage(payload) {
	const object = asObject(payload);
	const error = object?.error;
	if (typeof error === "string" && error.trim()) return error.trim();
	const errorObject = asObject(error);
	return trimToUndefined(errorObject?.message) ?? trimToUndefined(errorObject?.detail) ?? trimToUndefined(object?.message);
}
function extractVydraResultUrls(payload, kind) {
	const urls = /* @__PURE__ */ new Set();
	const preferredKeys = kind === "audio" ? ["audioUrl", "audioUrls"] : kind === "image" ? ["imageUrl", "imageUrls"] : ["videoUrl", "videoUrls"];
	const sharedKeys = [
		"resultUrl",
		"resultUrls",
		"outputUrl",
		"outputUrls",
		"url",
		"urls"
	];
	const recurseKeys = [
		"output",
		"outputs",
		"result",
		"results",
		"data",
		"asset",
		"assets"
	];
	const visit = (value, depth = 0) => {
		if (depth > 5) return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry, depth + 1);
			return;
		}
		const object = asObject(value);
		if (!object) return;
		for (const key of [...preferredKeys, ...sharedKeys]) addUrlValue(object[key], urls);
		for (const key of recurseKeys) if (key in object) visit(object[key], depth + 1);
	};
	visit(payload);
	return [...urls];
}
function resolveVydraFileExtension(kind, mimeType) {
	return extensionForMime(mimeType)?.slice(1) ?? (kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4");
}
async function downloadVydraAsset(params) {
	const response = await fetchWithTimeout(params.url, { method: "GET" }, params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, params.fetchFn);
	await assertOkOrThrowHttpError(response, `Vydra ${params.kind} download failed`);
	const mimeType = response.headers.get("content-type")?.trim() || (params.kind === "image" ? "image/png" : params.kind === "audio" ? "audio/mpeg" : "video/mp4");
	const arrayBuffer = await response.arrayBuffer();
	const extension = resolveVydraFileExtension(params.kind, mimeType);
	const fileStem = params.kind === "image" ? "image" : params.kind === "audio" ? "audio" : "video";
	return {
		buffer: Buffer.from(arrayBuffer),
		mimeType,
		fileName: `${fileStem}-1.${extension}`
	};
}
async function waitForVydraJob(params) {
	const deadline = createProviderOperationDeadline({
		timeoutMs: params.timeoutMs,
		label: `Vydra job ${params.jobId}`
	});
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
		const response = await fetchWithTimeout(`${params.baseUrl}/jobs/${params.jobId}`, {
			method: "GET",
			headers: params.headers
		}, resolveProviderOperationTimeoutMs({
			deadline,
			defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS
		}), params.fetchFn);
		await assertOkOrThrowHttpError(response, "Vydra job status request failed");
		const payload = await response.json();
		const status = resolveVydraResponseStatus(payload);
		if (status === "completed" || extractVydraResultUrls(payload, params.kind).length > 0) return payload;
		if (status === "failed" || status === "error" || status === "cancelled") throw new Error(resolveVydraErrorMessage(payload) ?? `Vydra job ${params.jobId} failed`);
		await waitProviderOperationPollInterval({
			deadline,
			pollIntervalMs: POLL_INTERVAL_MS
		});
	}
	throw new Error(`Vydra job ${params.jobId} did not finish in time`);
}
async function resolveCompletedVydraPayload(params) {
	if (resolveVydraResponseStatus(params.submitted) === "completed" || extractVydraResultUrls(params.submitted, params.kind).length > 0) return params.submitted;
	const jobId = resolveVydraResponseJobId(params.submitted);
	if (!jobId) throw new Error(resolveVydraErrorMessage(params.submitted) ?? params.missingJobIdMessage);
	return waitForVydraJob({
		baseUrl: params.baseUrl,
		jobId,
		headers: params.headers,
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn,
		kind: params.kind
	});
}
//#endregion
export { DEFAULT_VYDRA_VOICE_ID as a, normalizeVydraBaseUrl as c, resolveVydraResponseJobId as d, resolveVydraResponseStatus as f, DEFAULT_VYDRA_VIDEO_MODEL as i, resolveCompletedVydraPayload as l, DEFAULT_VYDRA_IMAGE_MODEL as n, downloadVydraAsset as o, trimToUndefined as p, DEFAULT_VYDRA_SPEECH_MODEL as r, extractVydraResultUrls as s, DEFAULT_VYDRA_BASE_URL as t, resolveVydraRequestContext as u };
