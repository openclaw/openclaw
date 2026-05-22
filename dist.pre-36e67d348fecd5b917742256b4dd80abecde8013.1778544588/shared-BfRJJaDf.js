import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { r as fetchWithTimeout } from "./fetch-timeout-DFw1jlef.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-PJfipwb1.js";
import { d as resolveProviderOperationTimeoutMs, f as waitProviderOperationPollInterval, n as createProviderOperationDeadline, u as resolveProviderHttpRequestConfig } from "./shared-DaLo5cP8.js";
import "./text-runtime-FOsx_CPC.js";
import { a as resolveApiKeyForProvider } from "./provider-auth-runtime-DQhted_7.js";
import "./provider-http-CsEZxABD.js";
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
function inferExtension(kind, mimeType) {
	const normalized = normalizeLowercaseStringOrEmpty(mimeType);
	if (normalized.includes("jpeg")) return "jpg";
	if (normalized.includes("webp")) return "webp";
	if (normalized.includes("wav")) return "wav";
	if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
	if (normalized.includes("webm")) return "webm";
	if (normalized.includes("quicktime")) return "mov";
	return kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4";
}
async function downloadVydraAsset(params) {
	const response = await fetchWithTimeout(params.url, { method: "GET" }, params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, params.fetchFn);
	await assertOkOrThrowHttpError(response, `Vydra ${params.kind} download failed`);
	const mimeType = response.headers.get("content-type")?.trim() || (params.kind === "image" ? "image/png" : params.kind === "audio" ? "audio/mpeg" : "video/mp4");
	const arrayBuffer = await response.arrayBuffer();
	const extension = inferExtension(params.kind, mimeType);
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
