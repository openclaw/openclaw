import { D as runExec, G as resolveAgentModelPrimaryValue, W as resolveAgentModelFallbackValues } from "./agent-scope-CSkwQImO.js";
import { $ as shouldLogVerbose, X as logVerbose, t as createSubsystemLogger, ut as resolvePreferredOpenClawTmpDir } from "./subsystem-B3k5RmW0.js";
import { J as mergeInboundPathRoots, K as DEFAULT_IMESSAGE_ATTACHMENT_ROOTS, L as loadConfig, T as resolveApiKeyForProvider, Y as resolveIMessageAttachmentRoots, c as normalizeProviderId, fn as resolveOpenClawAgentDir, h as normalizeGoogleModelId, q as isInboundPathAllowed, w as requireApiKey } from "./model-selection-aaCyoEgM.js";
import { t as normalizeChatType } from "./chat-type-CTrit63N.js";
import { c as detectMime, f as isAudioFileName, m as kindFromMime, u as getFileExtension } from "./image-ops-DBNY7ywb.js";
import { t as describeImageWithModel, w as ensureOpenClawModelsJson } from "./image-Dh8HdczS.js";
import { n as collectProviderApiKeysForExecution, r as executeWithApiKeyRotation, t as parseGeminiAuth } from "./gemini-auth-DjFUqCSi.js";
import { n as fetchWithTimeout } from "./fetch-timeout-O8zj7G_z.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-vB1za2HG.js";
import { i as fetchRemoteMedia, n as getDefaultMediaLocalRoots, r as MediaFetchError } from "./local-roots-CkiB5qEM.js";
import path from "node:path";
import { constants } from "node:fs";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import process$1 from "node:process";

//#region src/auto-reply/templating.ts
function formatTemplateValue(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "symbol" || typeof value === "function") return value.toString();
	if (Array.isArray(value)) return value.flatMap((entry) => {
		if (entry == null) return [];
		if (typeof entry === "string") return [entry];
		if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") return [String(entry)];
		return [];
	}).join(",");
	if (typeof value === "object") return "";
	return "";
}
function applyTemplate(str, ctx) {
	if (!str) return "";
	return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
		const value = ctx[key];
		return formatTemplateValue(value);
	});
}

//#endregion
//#region src/media-understanding/defaults.ts
const MB = 1024 * 1024;
const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MAX_CHARS_BY_CAPABILITY = {
	image: DEFAULT_MAX_CHARS,
	audio: void 0,
	video: DEFAULT_MAX_CHARS
};
const DEFAULT_MAX_BYTES = {
	image: 10 * MB,
	audio: 20 * MB,
	video: 50 * MB
};
const DEFAULT_TIMEOUT_SECONDS = {
	image: 60,
	audio: 60,
	video: 120
};
const DEFAULT_PROMPT = {
	image: "Describe the image.",
	audio: "Transcribe the audio.",
	video: "Describe the video."
};
const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
const DEFAULT_AUDIO_MODELS = {
	groq: "whisper-large-v3-turbo",
	openai: "gpt-4o-mini-transcribe",
	deepgram: "nova-3",
	mistral: "voxtral-mini-latest"
};
const AUTO_AUDIO_KEY_PROVIDERS = [
	"openai",
	"groq",
	"deepgram",
	"google",
	"mistral"
];
const AUTO_IMAGE_KEY_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"minimax",
	"zai"
];
const AUTO_VIDEO_KEY_PROVIDERS = ["google", "moonshot"];
const DEFAULT_IMAGE_MODELS = {
	openai: "gpt-5-mini",
	anthropic: "claude-opus-4-6",
	google: "gemini-3-flash-preview",
	minimax: "MiniMax-VL-01",
	zai: "glm-4.6v"
};
const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
const DEFAULT_MEDIA_CONCURRENCY = 2;

//#endregion
//#region src/media-understanding/providers/anthropic/index.ts
const anthropicProvider = {
	id: "anthropic",
	capabilities: ["image"],
	describeImage: describeImageWithModel
};

//#endregion
//#region src/media-understanding/providers/shared.ts
const MAX_ERROR_CHARS = 300;
function normalizeBaseUrl(baseUrl, fallback) {
	return (baseUrl?.trim() || fallback).replace(/\/+$/, "");
}
async function fetchWithTimeoutGuarded(url, init, timeoutMs, fetchFn, options) {
	return await fetchWithSsrFGuard({
		url,
		fetchImpl: fetchFn,
		init,
		timeoutMs,
		policy: options?.ssrfPolicy,
		lookupFn: options?.lookupFn,
		pinDns: options?.pinDns
	});
}
async function postTranscriptionRequest(params) {
	return fetchWithTimeoutGuarded(params.url, {
		method: "POST",
		headers: params.headers,
		body: params.body
	}, params.timeoutMs, params.fetchFn, params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : void 0);
}
async function readErrorResponse(res) {
	try {
		const collapsed = (await res.text()).replace(/\s+/g, " ").trim();
		if (!collapsed) return;
		if (collapsed.length <= MAX_ERROR_CHARS) return collapsed;
		return `${collapsed.slice(0, MAX_ERROR_CHARS)}…`;
	} catch {
		return;
	}
}
async function assertOkOrThrowHttpError(res, label) {
	if (res.ok) return;
	const detail = await readErrorResponse(res);
	const suffix = detail ? `: ${detail}` : "";
	throw new Error(`${label} (HTTP ${res.status})${suffix}`);
}
function requireTranscriptionText(value, missingMessage) {
	const text = value?.trim();
	if (!text) throw new Error(missingMessage);
	return text;
}

//#endregion
//#region src/media-understanding/providers/deepgram/audio.ts
const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";
function resolveModel$2(model) {
	return model?.trim() || DEFAULT_DEEPGRAM_AUDIO_MODEL;
}
async function transcribeDeepgramAudio(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_DEEPGRAM_AUDIO_BASE_URL);
	const allowPrivate = Boolean(params.baseUrl?.trim());
	const model = resolveModel$2(params.model);
	const url = new URL(`${baseUrl}/listen`);
	url.searchParams.set("model", model);
	if (params.language?.trim()) url.searchParams.set("language", params.language.trim());
	if (params.query) for (const [key, value] of Object.entries(params.query)) {
		if (value === void 0) continue;
		url.searchParams.set(key, String(value));
	}
	const headers = new Headers(params.headers);
	if (!headers.has("authorization")) headers.set("authorization", `Token ${params.apiKey}`);
	if (!headers.has("content-type")) headers.set("content-type", params.mime ?? "application/octet-stream");
	const body = new Uint8Array(params.buffer);
	const { response: res, release } = await postTranscriptionRequest({
		url: url.toString(),
		headers,
		body,
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork: allowPrivate
	});
	try {
		await assertOkOrThrowHttpError(res, "Audio transcription failed");
		return {
			text: requireTranscriptionText((await res.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript, "Audio transcription response missing transcript"),
			model
		};
	} finally {
		await release();
	}
}

//#endregion
//#region src/media-understanding/providers/deepgram/index.ts
const deepgramProvider = {
	id: "deepgram",
	capabilities: ["audio"],
	transcribeAudio: transcribeDeepgramAudio
};

//#endregion
//#region src/media-understanding/providers/google/inline-data.ts
async function generateGeminiInlineDataText(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
	const allowPrivate = Boolean(params.baseUrl?.trim());
	const model = (() => {
		const trimmed = params.model?.trim();
		if (!trimmed) return params.defaultModel;
		return normalizeGoogleModelId(trimmed);
	})();
	const url = `${baseUrl}/models/${model}:generateContent`;
	const authHeaders = parseGeminiAuth(params.apiKey);
	const headers = new Headers(params.headers);
	for (const [key, value] of Object.entries(authHeaders.headers)) if (!headers.has(key)) headers.set(key, value);
	const body = { contents: [{
		role: "user",
		parts: [{ text: params.prompt?.trim() || params.defaultPrompt }, { inline_data: {
			mime_type: params.mime ?? params.defaultMime,
			data: params.buffer.toString("base64")
		} }]
	}] };
	const { response: res, release } = await fetchWithTimeoutGuarded(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body)
	}, params.timeoutMs, fetchFn, allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : void 0);
	try {
		await assertOkOrThrowHttpError(res, params.httpErrorLabel);
		const text = ((await res.json()).candidates?.[0]?.content?.parts ?? []).map((part) => part?.text?.trim()).filter(Boolean).join("\n");
		if (!text) throw new Error(params.missingTextError);
		return {
			text,
			model
		};
	} finally {
		await release();
	}
}

//#endregion
//#region src/media-understanding/providers/google/audio.ts
const DEFAULT_GOOGLE_AUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
async function transcribeGeminiAudio(params) {
	const { text, model } = await generateGeminiInlineDataText({
		...params,
		defaultBaseUrl: DEFAULT_GOOGLE_AUDIO_BASE_URL,
		defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
		defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
		defaultMime: "audio/wav",
		httpErrorLabel: "Audio transcription failed",
		missingTextError: "Audio transcription response missing text"
	});
	return {
		text,
		model
	};
}

//#endregion
//#region src/media-understanding/providers/google/video.ts
const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";
async function describeGeminiVideo(params) {
	const { text, model } = await generateGeminiInlineDataText({
		...params,
		defaultBaseUrl: DEFAULT_GOOGLE_VIDEO_BASE_URL,
		defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
		defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
		defaultMime: "video/mp4",
		httpErrorLabel: "Video description failed",
		missingTextError: "Video description response missing text"
	});
	return {
		text,
		model
	};
}

//#endregion
//#region src/media-understanding/providers/google/index.ts
const googleProvider = {
	id: "google",
	capabilities: [
		"image",
		"audio",
		"video"
	],
	describeImage: describeImageWithModel,
	transcribeAudio: transcribeGeminiAudio,
	describeVideo: describeGeminiVideo
};

//#endregion
//#region src/media-understanding/providers/openai/audio.ts
const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";
function resolveModel$1(model) {
	return model?.trim() || DEFAULT_OPENAI_AUDIO_MODEL;
}
async function transcribeOpenAiCompatibleAudio(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENAI_AUDIO_BASE_URL);
	const allowPrivate = Boolean(params.baseUrl?.trim());
	const url = `${baseUrl}/audio/transcriptions`;
	const model = resolveModel$1(params.model);
	const form = new FormData();
	const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
	const bytes = new Uint8Array(params.buffer);
	const blob = new Blob([bytes], { type: params.mime ?? "application/octet-stream" });
	form.append("file", blob, fileName);
	form.append("model", model);
	if (params.language?.trim()) form.append("language", params.language.trim());
	if (params.prompt?.trim()) form.append("prompt", params.prompt.trim());
	const headers = new Headers(params.headers);
	if (!headers.has("authorization")) headers.set("authorization", `Bearer ${params.apiKey}`);
	const { response: res, release } = await postTranscriptionRequest({
		url,
		headers,
		body: form,
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork: allowPrivate
	});
	try {
		await assertOkOrThrowHttpError(res, "Audio transcription failed");
		return {
			text: requireTranscriptionText((await res.json()).text, "Audio transcription response missing text"),
			model
		};
	} finally {
		await release();
	}
}

//#endregion
//#region src/media-understanding/providers/groq/index.ts
const DEFAULT_GROQ_AUDIO_BASE_URL = "https://api.groq.com/openai/v1";
const groqProvider = {
	id: "groq",
	capabilities: ["audio"],
	transcribeAudio: (req) => transcribeOpenAiCompatibleAudio({
		...req,
		baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL
	})
};

//#endregion
//#region src/media-understanding/providers/minimax/index.ts
const minimaxProvider = {
	id: "minimax",
	capabilities: ["image"],
	describeImage: describeImageWithModel
};

//#endregion
//#region src/media-understanding/providers/mistral/index.ts
const DEFAULT_MISTRAL_AUDIO_BASE_URL = "https://api.mistral.ai/v1";
const mistralProvider = {
	id: "mistral",
	capabilities: ["audio"],
	transcribeAudio: (req) => transcribeOpenAiCompatibleAudio({
		...req,
		baseUrl: req.baseUrl ?? DEFAULT_MISTRAL_AUDIO_BASE_URL
	})
};

//#endregion
//#region src/media-understanding/providers/moonshot/video.ts
const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MOONSHOT_VIDEO_MODEL = "kimi-k2.5";
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";
function resolveModel(model) {
	return model?.trim() || DEFAULT_MOONSHOT_VIDEO_MODEL;
}
function resolvePrompt$1(prompt) {
	return prompt?.trim() || DEFAULT_MOONSHOT_VIDEO_PROMPT;
}
function coerceMoonshotText(payload) {
	const message = payload.choices?.[0]?.message;
	if (!message) return null;
	if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
	if (Array.isArray(message.content)) {
		const text = message.content.map((part) => typeof part.text === "string" ? part.text.trim() : "").filter(Boolean).join("\n").trim();
		if (text) return text;
	}
	if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content.trim();
	return null;
}
async function describeMoonshotVideo(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_MOONSHOT_VIDEO_BASE_URL);
	const model = resolveModel(params.model);
	const mime = params.mime ?? "video/mp4";
	const prompt = resolvePrompt$1(params.prompt);
	const url = `${baseUrl}/chat/completions`;
	const headers = new Headers(params.headers);
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	if (!headers.has("authorization")) headers.set("authorization", `Bearer ${params.apiKey}`);
	const body = {
		model,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: prompt
			}, {
				type: "video_url",
				video_url: { url: `data:${mime};base64,${params.buffer.toString("base64")}` }
			}]
		}]
	};
	const { response: res, release } = await fetchWithTimeoutGuarded(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body)
	}, params.timeoutMs, fetchFn);
	try {
		await assertOkOrThrowHttpError(res, "Moonshot video description failed");
		const text = coerceMoonshotText(await res.json());
		if (!text) throw new Error("Moonshot video description response missing content");
		return {
			text,
			model
		};
	} finally {
		await release();
	}
}

//#endregion
//#region src/media-understanding/providers/moonshot/index.ts
const moonshotProvider = {
	id: "moonshot",
	capabilities: ["image", "video"],
	describeImage: describeImageWithModel,
	describeVideo: describeMoonshotVideo
};

//#endregion
//#region src/media-understanding/providers/openai/index.ts
const openaiProvider = {
	id: "openai",
	capabilities: ["image"],
	describeImage: describeImageWithModel,
	transcribeAudio: transcribeOpenAiCompatibleAudio
};

//#endregion
//#region src/media-understanding/providers/zai/index.ts
const zaiProvider = {
	id: "zai",
	capabilities: ["image"],
	describeImage: describeImageWithModel
};

//#endregion
//#region src/media-understanding/providers/index.ts
const PROVIDERS = [
	groqProvider,
	openaiProvider,
	googleProvider,
	anthropicProvider,
	minimaxProvider,
	moonshotProvider,
	mistralProvider,
	zaiProvider,
	deepgramProvider
];
function normalizeMediaProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "gemini") return "google";
	return normalized;
}
function buildMediaUnderstandingRegistry(overrides) {
	const registry = /* @__PURE__ */ new Map();
	for (const provider of PROVIDERS) registry.set(normalizeMediaProviderId(provider.id), provider);
	if (overrides) for (const [key, provider] of Object.entries(overrides)) {
		const normalizedKey = normalizeMediaProviderId(key);
		const existing = registry.get(normalizedKey);
		const merged = existing ? {
			...existing,
			...provider,
			capabilities: provider.capabilities ?? existing.capabilities
		} : provider;
		registry.set(normalizedKey, merged);
	}
	return registry;
}
function getMediaUnderstandingProvider(id, registry) {
	return registry.get(normalizeMediaProviderId(id));
}

//#endregion
//#region src/media-understanding/scope.ts
function normalizeDecision(value) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "allow") return "allow";
	if (normalized === "deny") return "deny";
}
function normalizeMatch(value) {
	return value?.trim().toLowerCase() || void 0;
}
function normalizeMediaUnderstandingChatType(raw) {
	return normalizeChatType(raw ?? void 0);
}
function resolveMediaUnderstandingScope(params) {
	const scope = params.scope;
	if (!scope) return "allow";
	const channel = normalizeMatch(params.channel);
	const chatType = normalizeMediaUnderstandingChatType(params.chatType);
	const sessionKey = normalizeMatch(params.sessionKey) ?? "";
	for (const rule of scope.rules ?? []) {
		if (!rule) continue;
		const action = normalizeDecision(rule.action) ?? "allow";
		const match = rule.match ?? {};
		const matchChannel = normalizeMatch(match.channel);
		const matchChatType = normalizeMediaUnderstandingChatType(match.chatType);
		const matchPrefix = normalizeMatch(match.keyPrefix);
		if (matchChannel && matchChannel !== channel) continue;
		if (matchChatType && matchChatType !== chatType) continue;
		if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
		return action;
	}
	return normalizeDecision(scope.default) ?? "allow";
}

//#endregion
//#region src/media-understanding/resolve.ts
function resolveTimeoutMs(seconds, fallbackSeconds) {
	const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds;
	return Math.max(1e3, Math.floor(value * 1e3));
}
function resolvePrompt(capability, prompt, maxChars) {
	const base = prompt?.trim() || DEFAULT_PROMPT[capability];
	if (!maxChars || capability === "audio") return base;
	return `${base} Respond in at most ${maxChars} characters.`;
}
function resolveMaxChars(params) {
	const { capability, entry, cfg } = params;
	const configured = entry.maxChars ?? params.config?.maxChars ?? cfg.tools?.media?.[capability]?.maxChars;
	if (typeof configured === "number") return configured;
	return DEFAULT_MAX_CHARS_BY_CAPABILITY[capability];
}
function resolveMaxBytes(params) {
	const configured = params.entry.maxBytes ?? params.config?.maxBytes ?? params.cfg.tools?.media?.[params.capability]?.maxBytes;
	if (typeof configured === "number") return configured;
	return DEFAULT_MAX_BYTES[params.capability];
}
function resolveScopeDecision(params) {
	return resolveMediaUnderstandingScope({
		scope: params.scope,
		sessionKey: params.ctx.SessionKey,
		channel: params.ctx.Surface ?? params.ctx.Provider,
		chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType)
	});
}
function resolveEntryCapabilities(params) {
	if ((params.entry.type ?? (params.entry.command ? "cli" : "provider")) === "cli") return;
	const providerId = normalizeMediaProviderId(params.entry.provider ?? "");
	if (!providerId) return;
	return params.providerRegistry.get(providerId)?.capabilities;
}
function resolveModelEntries(params) {
	const { cfg, capability, config } = params;
	const sharedModels = cfg.tools?.media?.models ?? [];
	const entries = [...(config?.models ?? []).map((entry) => ({
		entry,
		source: "capability"
	})), ...sharedModels.map((entry) => ({
		entry,
		source: "shared"
	}))];
	if (entries.length === 0) return [];
	return entries.filter(({ entry, source }) => {
		const caps = entry.capabilities && entry.capabilities.length > 0 ? entry.capabilities : source === "shared" ? resolveEntryCapabilities({
			entry,
			providerRegistry: params.providerRegistry
		}) : void 0;
		if (!caps || caps.length === 0) {
			if (source === "shared") {
				if (shouldLogVerbose()) logVerbose(`Skipping shared media model without capabilities: ${entry.provider ?? entry.command ?? "unknown"}`);
				return false;
			}
			return true;
		}
		return caps.includes(capability);
	}).map(({ entry }) => entry);
}
function resolveConcurrency(cfg) {
	const configured = cfg.tools?.media?.concurrency;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return Math.floor(configured);
	return DEFAULT_MEDIA_CONCURRENCY;
}

//#endregion
//#region src/infra/unhandled-rejections.ts
const handlers = /* @__PURE__ */ new Set();
/**
* Checks if an error is an AbortError.
* These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
*/
function isAbortError(err) {
	if (!err || typeof err !== "object") return false;
	if (("name" in err ? String(err.name) : "") === "AbortError") return true;
	if (("message" in err && typeof err.message === "string" ? err.message : "") === "This operation was aborted") return true;
	return false;
}
function registerUnhandledRejectionHandler(handler) {
	handlers.add(handler);
	return () => {
		handlers.delete(handler);
	};
}

//#endregion
//#region src/plugin-sdk/temp-path.ts
function sanitizePrefix(prefix) {
	return prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tmp";
}
function sanitizeExtension(extension) {
	if (!extension) return "";
	const token = ((extension.startsWith(".") ? extension : `.${extension}`).match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "").replace(/^[._-]+/, "");
	if (!token) return "";
	return `.${token}`;
}
function resolveTempRoot(tmpDir) {
	return tmpDir ?? resolvePreferredOpenClawTmpDir();
}
function buildRandomTempFilePath(params) {
	const prefix = sanitizePrefix(params.prefix);
	const extension = sanitizeExtension(params.extension);
	const nowCandidate = params.now;
	const now = typeof nowCandidate === "number" && Number.isFinite(nowCandidate) ? Math.trunc(nowCandidate) : Date.now();
	const uuid = params.uuid?.trim() || crypto.randomUUID();
	return path.join(resolveTempRoot(params.tmpDir), `${prefix}-${now}-${uuid}${extension}`);
}

//#endregion
//#region src/media-understanding/errors.ts
var MediaUnderstandingSkipError = class extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason;
		this.name = "MediaUnderstandingSkipError";
	}
};
function isMediaUnderstandingSkipError(err) {
	return err instanceof MediaUnderstandingSkipError;
}

//#endregion
//#region src/media-understanding/attachments.ts
const DEFAULT_MAX_ATTACHMENTS = 1;
const DEFAULT_LOCAL_PATH_ROOTS = mergeInboundPathRoots(getDefaultMediaLocalRoots(), DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
function normalizeAttachmentPath(raw) {
	const value = raw?.trim();
	if (!value) return;
	if (value.startsWith("file://")) try {
		return fileURLToPath(value);
	} catch {
		return;
	}
	return value;
}
function normalizeAttachments(ctx) {
	const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : void 0;
	const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : void 0;
	const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : void 0;
	const resolveMime = (count, index) => {
		const typeHint = typesFromArray?.[index];
		const trimmed = typeof typeHint === "string" ? typeHint.trim() : "";
		if (trimmed) return trimmed;
		return count === 1 ? ctx.MediaType : void 0;
	};
	if (pathsFromArray && pathsFromArray.length > 0) {
		const count = pathsFromArray.length;
		const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : void 0;
		return pathsFromArray.map((value, index) => ({
			path: value?.trim() || void 0,
			url: urls?.[index] ?? ctx.MediaUrl,
			mime: resolveMime(count, index),
			index
		})).filter((entry) => Boolean(entry.path?.trim() || entry.url?.trim()));
	}
	if (urlsFromArray && urlsFromArray.length > 0) {
		const count = urlsFromArray.length;
		return urlsFromArray.map((value, index) => ({
			path: void 0,
			url: value?.trim() || void 0,
			mime: resolveMime(count, index),
			index
		})).filter((entry) => Boolean(entry.url?.trim()));
	}
	const pathValue = ctx.MediaPath?.trim();
	const url = ctx.MediaUrl?.trim();
	if (!pathValue && !url) return [];
	return [{
		path: pathValue || void 0,
		url: url || void 0,
		mime: ctx.MediaType,
		index: 0
	}];
}
function resolveAttachmentKind(attachment) {
	const kind = kindFromMime(attachment.mime);
	if (kind === "image" || kind === "audio" || kind === "video") return kind;
	const ext = getFileExtension(attachment.path ?? attachment.url);
	if (!ext) return "unknown";
	if ([
		".mp4",
		".mov",
		".mkv",
		".webm",
		".avi",
		".m4v"
	].includes(ext)) return "video";
	if (isAudioFileName(attachment.path ?? attachment.url)) return "audio";
	if ([
		".png",
		".jpg",
		".jpeg",
		".webp",
		".gif",
		".bmp",
		".tiff",
		".tif"
	].includes(ext)) return "image";
	return "unknown";
}
function isVideoAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "video";
}
function isAudioAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "audio";
}
function isImageAttachment(attachment) {
	return resolveAttachmentKind(attachment) === "image";
}
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
function orderAttachments(attachments, prefer) {
	if (!prefer || prefer === "first") return attachments;
	if (prefer === "last") return [...attachments].toReversed();
	if (prefer === "path") {
		const withPath = attachments.filter((item) => item.path);
		const withoutPath = attachments.filter((item) => !item.path);
		return [...withPath, ...withoutPath];
	}
	if (prefer === "url") {
		const withUrl = attachments.filter((item) => item.url);
		const withoutUrl = attachments.filter((item) => !item.url);
		return [...withUrl, ...withoutUrl];
	}
	return attachments;
}
function selectAttachments(params) {
	const { capability, attachments, policy } = params;
	const matches = attachments.filter((item) => {
		if (capability === "audio" && item.alreadyTranscribed) return false;
		if (capability === "image") return isImageAttachment(item);
		if (capability === "audio") return isAudioAttachment(item);
		return isVideoAttachment(item);
	});
	if (matches.length === 0) return [];
	const ordered = orderAttachments(matches, policy?.prefer);
	const mode = policy?.mode ?? "first";
	const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
	if (mode === "all") return ordered.slice(0, Math.max(1, maxAttachments));
	return ordered.slice(0, 1);
}
var MediaAttachmentCache = class {
	constructor(attachments, options) {
		this.entries = /* @__PURE__ */ new Map();
		this.attachments = attachments;
		this.localPathRoots = mergeInboundPathRoots(options?.localPathRoots, DEFAULT_LOCAL_PATH_ROOTS);
		for (const attachment of attachments) this.entries.set(attachment.index, { attachment });
	}
	async getBuffer(params) {
		const entry = await this.ensureEntry(params.attachmentIndex);
		if (entry.buffer) {
			if (entry.buffer.length > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			return {
				buffer: entry.buffer,
				mime: entry.bufferMime,
				fileName: entry.bufferFileName ?? `media-${params.attachmentIndex + 1}`,
				size: entry.buffer.length
			};
		}
		if (entry.resolvedPath) {
			const size = await this.ensureLocalStat(entry);
			if (entry.resolvedPath) {
				if (size !== void 0 && size > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
				const buffer = await fs.readFile(entry.resolvedPath);
				entry.buffer = buffer;
				entry.bufferMime = entry.bufferMime ?? entry.attachment.mime ?? await detectMime({
					buffer,
					filePath: entry.resolvedPath
				});
				entry.bufferFileName = path.basename(entry.resolvedPath) || `media-${params.attachmentIndex + 1}`;
				return {
					buffer,
					mime: entry.bufferMime,
					fileName: entry.bufferFileName,
					size: buffer.length
				};
			}
		}
		const url = entry.attachment.url?.trim();
		if (!url) throw new MediaUnderstandingSkipError("empty", `Attachment ${params.attachmentIndex + 1} has no path or URL.`);
		try {
			const fetchImpl = (input, init) => fetchWithTimeout(resolveRequestUrl(input), init ?? {}, params.timeoutMs, fetch);
			const fetched = await fetchRemoteMedia({
				url,
				fetchImpl,
				maxBytes: params.maxBytes
			});
			entry.buffer = fetched.buffer;
			entry.bufferMime = entry.attachment.mime ?? fetched.contentType ?? await detectMime({
				buffer: fetched.buffer,
				filePath: fetched.fileName ?? url
			});
			entry.bufferFileName = fetched.fileName ?? `media-${params.attachmentIndex + 1}`;
			return {
				buffer: fetched.buffer,
				mime: entry.bufferMime,
				fileName: entry.bufferFileName,
				size: fetched.buffer.length
			};
		} catch (err) {
			if (err instanceof MediaFetchError && err.code === "max_bytes") throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			if (isAbortError(err)) throw new MediaUnderstandingSkipError("timeout", `Attachment ${params.attachmentIndex + 1} timed out while fetching.`);
			throw err;
		}
	}
	async getPath(params) {
		const entry = await this.ensureEntry(params.attachmentIndex);
		if (entry.resolvedPath) {
			if (params.maxBytes) {
				const size = await this.ensureLocalStat(entry);
				if (entry.resolvedPath) {
					if (size !== void 0 && size > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
				}
			}
			if (entry.resolvedPath) return { path: entry.resolvedPath };
		}
		if (entry.tempPath) {
			if (params.maxBytes && entry.buffer && entry.buffer.length > params.maxBytes) throw new MediaUnderstandingSkipError("maxBytes", `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`);
			return {
				path: entry.tempPath,
				cleanup: entry.tempCleanup
			};
		}
		const maxBytes = params.maxBytes ?? Number.POSITIVE_INFINITY;
		const bufferResult = await this.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs: params.timeoutMs
		});
		const tmpPath = buildRandomTempFilePath({
			prefix: "openclaw-media",
			extension: path.extname(bufferResult.fileName || "") || ""
		});
		await fs.writeFile(tmpPath, bufferResult.buffer);
		entry.tempPath = tmpPath;
		entry.tempCleanup = async () => {
			await fs.unlink(tmpPath).catch(() => {});
		};
		return {
			path: tmpPath,
			cleanup: entry.tempCleanup
		};
	}
	async cleanup() {
		const cleanups = [];
		for (const entry of this.entries.values()) if (entry.tempCleanup) {
			cleanups.push(Promise.resolve(entry.tempCleanup()));
			entry.tempCleanup = void 0;
		}
		await Promise.all(cleanups);
	}
	async ensureEntry(attachmentIndex) {
		const existing = this.entries.get(attachmentIndex);
		if (existing) {
			if (!existing.resolvedPath) existing.resolvedPath = this.resolveLocalPath(existing.attachment);
			return existing;
		}
		const attachment = this.attachments.find((item) => item.index === attachmentIndex) ?? { index: attachmentIndex };
		const entry = {
			attachment,
			resolvedPath: this.resolveLocalPath(attachment)
		};
		this.entries.set(attachmentIndex, entry);
		return entry;
	}
	resolveLocalPath(attachment) {
		const rawPath = normalizeAttachmentPath(attachment.path);
		if (!rawPath) return;
		return path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
	}
	async ensureLocalStat(entry) {
		if (!entry.resolvedPath) return;
		if (!isInboundPathAllowed({
			filePath: entry.resolvedPath,
			roots: this.localPathRoots
		})) {
			entry.resolvedPath = void 0;
			if (shouldLogVerbose()) logVerbose(`Blocked attachment path outside allowed roots: ${entry.attachment.path ?? entry.attachment.url ?? "(unknown)"}`);
			return;
		}
		if (entry.statSize !== void 0) return entry.statSize;
		try {
			const currentPath = entry.resolvedPath;
			const stat = await fs.stat(currentPath);
			if (!stat.isFile()) {
				entry.resolvedPath = void 0;
				return;
			}
			const canonicalPath = await fs.realpath(currentPath).catch(() => currentPath);
			if (!isInboundPathAllowed({
				filePath: canonicalPath,
				roots: await this.getCanonicalLocalPathRoots()
			})) {
				entry.resolvedPath = void 0;
				if (shouldLogVerbose()) logVerbose(`Blocked canonicalized attachment path outside allowed roots: ${canonicalPath}`);
				return;
			}
			entry.resolvedPath = canonicalPath;
			entry.statSize = stat.size;
			return stat.size;
		} catch (err) {
			entry.resolvedPath = void 0;
			if (shouldLogVerbose()) logVerbose(`Failed to read attachment ${entry.attachment.index + 1}: ${String(err)}`);
			return;
		}
	}
	async getCanonicalLocalPathRoots() {
		if (this.canonicalLocalPathRoots) return await this.canonicalLocalPathRoots;
		this.canonicalLocalPathRoots = (async () => mergeInboundPathRoots(this.localPathRoots, await Promise.all(this.localPathRoots.map(async (root) => {
			if (root.includes("*")) return root;
			return await fs.realpath(root).catch(() => root);
		}))))();
		return await this.canonicalLocalPathRoots;
	}
};

//#endregion
//#region src/agents/model-catalog.ts
const log = createSubsystemLogger("model-catalog");
let modelCatalogPromise = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery-B_t1owo2.js").then((n) => n.r);
let importPiSdk = defaultImportPiSdk;
const CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const NON_PI_NATIVE_MODEL_PROVIDERS = new Set(["kilocode"]);
function applyOpenAICodexSparkFallback(models) {
	if (models.some((entry) => entry.provider === CODEX_PROVIDER && entry.id.toLowerCase() === OPENAI_CODEX_GPT53_SPARK_MODEL_ID)) return;
	const baseModel = models.find((entry) => entry.provider === CODEX_PROVIDER && entry.id.toLowerCase() === OPENAI_CODEX_GPT53_MODEL_ID);
	if (!baseModel) return;
	models.push({
		...baseModel,
		id: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
		name: OPENAI_CODEX_GPT53_SPARK_MODEL_ID
	});
}
function normalizeConfiguredModelInput(input) {
	if (!Array.isArray(input)) return;
	const normalized = input.filter((item) => item === "text" || item === "image");
	return normalized.length > 0 ? normalized : void 0;
}
function readConfiguredOptInProviderModels(config) {
	const providers = config.models?.providers;
	if (!providers || typeof providers !== "object") return [];
	const out = [];
	for (const [providerRaw, providerValue] of Object.entries(providers)) {
		const provider = providerRaw.toLowerCase().trim();
		if (!NON_PI_NATIVE_MODEL_PROVIDERS.has(provider)) continue;
		if (!providerValue || typeof providerValue !== "object") continue;
		const configuredModels = providerValue.models;
		if (!Array.isArray(configuredModels)) continue;
		for (const configuredModel of configuredModels) {
			if (!configuredModel || typeof configuredModel !== "object") continue;
			const idRaw = configuredModel.id;
			if (typeof idRaw !== "string") continue;
			const id = idRaw.trim();
			if (!id) continue;
			const rawName = configuredModel.name;
			const name = (typeof rawName === "string" ? rawName : id).trim() || id;
			const contextWindowRaw = configuredModel.contextWindow;
			const contextWindow = typeof contextWindowRaw === "number" && contextWindowRaw > 0 ? contextWindowRaw : void 0;
			const reasoningRaw = configuredModel.reasoning;
			const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : void 0;
			const input = normalizeConfiguredModelInput(configuredModel.input);
			out.push({
				id,
				name,
				provider,
				contextWindow,
				reasoning,
				input
			});
		}
	}
	return out;
}
function mergeConfiguredOptInProviderModels(params) {
	const configured = readConfiguredOptInProviderModels(params.config);
	if (configured.length === 0) return;
	const seen = new Set(params.models.map((entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`));
	for (const entry of configured) {
		const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
		if (seen.has(key)) continue;
		params.models.push(entry);
		seen.add(key);
	}
}
async function loadModelCatalog(params) {
	if (params?.useCache === false) modelCatalogPromise = null;
	if (modelCatalogPromise) return modelCatalogPromise;
	modelCatalogPromise = (async () => {
		const models = [];
		const sortModels = (entries) => entries.sort((a, b) => {
			const p = a.provider.localeCompare(b.provider);
			if (p !== 0) return p;
			return a.name.localeCompare(b.name);
		});
		try {
			const cfg = params?.config ?? loadConfig();
			await ensureOpenClawModelsJson(cfg);
			const piSdk = await importPiSdk();
			const agentDir = resolveOpenClawAgentDir();
			const { join } = await import("node:path");
			const authStorage = piSdk.discoverAuthStorage(agentDir);
			const registry = new piSdk.ModelRegistry(authStorage, join(agentDir, "models.json"));
			const entries = Array.isArray(registry) ? registry : registry.getAll();
			for (const entry of entries) {
				const id = String(entry?.id ?? "").trim();
				if (!id) continue;
				const provider = String(entry?.provider ?? "").trim();
				if (!provider) continue;
				const name = String(entry?.name ?? id).trim() || id;
				const contextWindow = typeof entry?.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : void 0;
				const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : void 0;
				const input = Array.isArray(entry?.input) ? entry.input : void 0;
				models.push({
					id,
					name,
					provider,
					contextWindow,
					reasoning,
					input
				});
			}
			mergeConfiguredOptInProviderModels({
				config: cfg,
				models
			});
			applyOpenAICodexSparkFallback(models);
			if (models.length === 0) modelCatalogPromise = null;
			return sortModels(models);
		} catch (error) {
			if (!hasLoggedModelCatalogError) {
				hasLoggedModelCatalogError = true;
				log.warn(`Failed to load model catalog: ${String(error)}`);
			}
			modelCatalogPromise = null;
			if (models.length > 0) return sortModels(models);
			return [];
		}
	})();
	return modelCatalogPromise;
}
/**
* Check if a model supports image input based on its catalog entry.
*/
function modelSupportsVision(entry) {
	return entry?.input?.includes("image") ?? false;
}
/**
* Find a model in the catalog by provider and model ID.
*/
function findModelInCatalog(catalog, provider, modelId) {
	const normalizedProvider = provider.toLowerCase().trim();
	const normalizedModelId = modelId.toLowerCase().trim();
	return catalog.find((entry) => entry.provider.toLowerCase() === normalizedProvider && entry.id.toLowerCase() === normalizedModelId);
}

//#endregion
//#region src/media-understanding/fs.ts
async function fileExists(filePath) {
	if (!filePath) return false;
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

//#endregion
//#region src/media-understanding/output-extract.ts
function extractLastJsonObject(raw) {
	const trimmed = raw.trim();
	const start = trimmed.lastIndexOf("{");
	if (start === -1) return null;
	const slice = trimmed.slice(start);
	try {
		return JSON.parse(slice);
	} catch {
		return null;
	}
}
function extractGeminiResponse(raw) {
	const payload = extractLastJsonObject(raw);
	if (!payload || typeof payload !== "object") return null;
	const response = payload.response;
	if (typeof response !== "string") return null;
	return response.trim() || null;
}

//#endregion
//#region src/media-understanding/video.ts
function estimateBase64Size(bytes) {
	return Math.ceil(bytes / 3) * 4;
}
function resolveVideoMaxBase64Bytes(maxBytes) {
	const expanded = Math.floor(maxBytes * (4 / 3));
	return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}

//#endregion
//#region src/media-understanding/runner.entries.ts
function trimOutput(text, maxChars) {
	const trimmed = text.trim();
	if (!maxChars || trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(0, maxChars).trim();
}
function extractSherpaOnnxText(raw) {
	const tryParse = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const head = trimmed[0];
		if (head !== "{" && head !== "\"") return null;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") return tryParse(parsed);
			if (parsed && typeof parsed === "object") {
				const text = parsed.text;
				if (typeof text === "string" && text.trim()) return text.trim();
			}
		} catch {}
		return null;
	};
	const direct = tryParse(raw);
	if (direct) return direct;
	const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const parsed = tryParse(lines[i] ?? "");
		if (parsed) return parsed;
	}
	return null;
}
function commandBase(command) {
	return path.parse(command).name;
}
function findArgValue(args, keys) {
	for (let i = 0; i < args.length; i += 1) if (keys.includes(args[i] ?? "")) {
		const value = args[i + 1];
		if (value) return value;
	}
}
function hasArg(args, keys) {
	return args.some((arg) => keys.includes(arg));
}
function resolveWhisperOutputPath(args, mediaPath) {
	const outputDir = findArgValue(args, ["--output_dir", "-o"]);
	const outputFormat = findArgValue(args, ["--output_format"]);
	if (!outputDir || !outputFormat) return null;
	if (!outputFormat.split(",").map((value) => value.trim()).includes("txt")) return null;
	const base = path.parse(mediaPath).name;
	return path.join(outputDir, `${base}.txt`);
}
function resolveWhisperCppOutputPath(args) {
	if (!hasArg(args, ["-otxt", "--output-txt"])) return null;
	const outputBase = findArgValue(args, ["-of", "--output-file"]);
	if (!outputBase) return null;
	return `${outputBase}.txt`;
}
async function resolveCliOutput(params) {
	const commandId = commandBase(params.command);
	const fileOutput = commandId === "whisper-cli" ? resolveWhisperCppOutputPath(params.args) : commandId === "whisper" ? resolveWhisperOutputPath(params.args, params.mediaPath) : null;
	if (fileOutput && await fileExists(fileOutput)) try {
		const content = await fs.readFile(fileOutput, "utf8");
		if (content.trim()) return content.trim();
	} catch {}
	if (commandId === "gemini") {
		const response = extractGeminiResponse(params.stdout);
		if (response) return response;
	}
	if (commandId === "sherpa-onnx-offline") {
		const response = extractSherpaOnnxText(params.stdout);
		if (response) return response;
	}
	return params.stdout.trim();
}
function normalizeProviderQuery(options) {
	if (!options) return;
	const query = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === void 0) continue;
		query[key] = value;
	}
	return Object.keys(query).length > 0 ? query : void 0;
}
function buildDeepgramCompatQuery(options) {
	if (!options) return;
	const query = {};
	if (typeof options.detectLanguage === "boolean") query.detect_language = options.detectLanguage;
	if (typeof options.punctuate === "boolean") query.punctuate = options.punctuate;
	if (typeof options.smartFormat === "boolean") query.smart_format = options.smartFormat;
	return Object.keys(query).length > 0 ? query : void 0;
}
function normalizeDeepgramQueryKeys(query) {
	const normalized = { ...query };
	if ("detectLanguage" in normalized) {
		normalized.detect_language = normalized.detectLanguage;
		delete normalized.detectLanguage;
	}
	if ("smartFormat" in normalized) {
		normalized.smart_format = normalized.smartFormat;
		delete normalized.smartFormat;
	}
	return normalized;
}
function resolveProviderQuery(params) {
	const { providerId, config, entry } = params;
	const mergedOptions = normalizeProviderQuery({
		...config?.providerOptions?.[providerId],
		...entry.providerOptions?.[providerId]
	});
	if (providerId !== "deepgram") return mergedOptions;
	const query = normalizeDeepgramQueryKeys(mergedOptions ?? {});
	const compat = buildDeepgramCompatQuery({
		...config?.deepgram,
		...entry.deepgram
	});
	for (const [key, value] of Object.entries(compat ?? {})) if (query[key] === void 0) query[key] = value;
	return Object.keys(query).length > 0 ? query : void 0;
}
function buildModelDecision(params) {
	if (params.entryType === "cli") {
		const command = params.entry.command?.trim();
		return {
			type: "cli",
			provider: command ?? "cli",
			model: params.entry.model ?? command,
			outcome: params.outcome,
			reason: params.reason
		};
	}
	const providerIdRaw = params.entry.provider?.trim();
	return {
		type: "provider",
		provider: (providerIdRaw ? normalizeMediaProviderId(providerIdRaw) : void 0) ?? providerIdRaw,
		model: params.entry.model,
		outcome: params.outcome,
		reason: params.reason
	};
}
function resolveEntryRunOptions(params) {
	const { capability, entry, cfg } = params;
	const maxBytes = resolveMaxBytes({
		capability,
		entry,
		cfg,
		config: params.config
	});
	const maxChars = resolveMaxChars({
		capability,
		entry,
		cfg,
		config: params.config
	});
	return {
		maxBytes,
		maxChars,
		timeoutMs: resolveTimeoutMs(entry.timeoutSeconds ?? params.config?.timeoutSeconds ?? cfg.tools?.media?.[capability]?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS[capability]),
		prompt: resolvePrompt(capability, entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt, maxChars)
	};
}
async function resolveProviderExecutionAuth(params) {
	const auth = await resolveApiKeyForProvider({
		provider: params.providerId,
		cfg: params.cfg,
		profileId: params.entry.profile,
		preferredProfile: params.entry.preferredProfile,
		agentDir: params.agentDir
	});
	return {
		apiKeys: collectProviderApiKeysForExecution({
			provider: params.providerId,
			primaryApiKey: requireApiKey(auth, params.providerId)
		}),
		providerConfig: params.cfg.models?.providers?.[params.providerId]
	};
}
async function resolveProviderExecutionContext(params) {
	const { apiKeys, providerConfig } = await resolveProviderExecutionAuth({
		providerId: params.providerId,
		cfg: params.cfg,
		entry: params.entry,
		agentDir: params.agentDir
	});
	const baseUrl = params.entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
	const mergedHeaders = {
		...providerConfig?.headers,
		...params.config?.headers,
		...params.entry.headers
	};
	return {
		apiKeys,
		baseUrl,
		headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : void 0
	};
}
function formatDecisionSummary(decision) {
	const total = decision.attachments.length;
	const success = decision.attachments.filter((entry) => entry.chosen?.outcome === "success").length;
	const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
	const provider = chosen?.provider?.trim();
	const model = chosen?.model?.trim();
	const modelLabel = provider ? model ? `${provider}/${model}` : provider : void 0;
	const reason = decision.attachments.flatMap((entry) => entry.attempts.map((attempt) => attempt.reason).filter(Boolean)).find(Boolean);
	const shortReason = reason ? reason.split(":")[0]?.trim() : void 0;
	const countLabel = total > 0 ? ` (${success}/${total})` : "";
	const viaLabel = modelLabel ? ` via ${modelLabel}` : "";
	const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
	return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}
async function runProviderEntry(params) {
	const { entry, capability, cfg } = params;
	const providerIdRaw = entry.provider?.trim();
	if (!providerIdRaw) throw new Error(`Provider entry missing provider for ${capability}`);
	const providerId = normalizeMediaProviderId(providerIdRaw);
	const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
		capability,
		entry,
		cfg,
		config: params.config
	});
	if (capability === "image") {
		if (!params.agentDir) throw new Error("Image understanding requires agentDir");
		const modelId = entry.model?.trim();
		if (!modelId) throw new Error("Image understanding requires model id");
		const media = await params.cache.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs
		});
		const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
		const result = provider?.describeImage ? await provider.describeImage({
			buffer: media.buffer,
			fileName: media.fileName,
			mime: media.mime,
			model: modelId,
			provider: providerId,
			prompt,
			timeoutMs,
			profile: entry.profile,
			preferredProfile: entry.preferredProfile,
			agentDir: params.agentDir,
			cfg: params.cfg
		}) : await describeImageWithModel({
			buffer: media.buffer,
			fileName: media.fileName,
			mime: media.mime,
			model: modelId,
			provider: providerId,
			prompt,
			timeoutMs,
			profile: entry.profile,
			preferredProfile: entry.preferredProfile,
			agentDir: params.agentDir,
			cfg: params.cfg
		});
		return {
			kind: "image.description",
			attachmentIndex: params.attachmentIndex,
			text: trimOutput(result.text, maxChars),
			provider: providerId,
			model: result.model ?? modelId
		};
	}
	const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
	if (!provider) throw new Error(`Media provider not available: ${providerId}`);
	if (capability === "audio") {
		if (!provider.transcribeAudio) throw new Error(`Audio transcription provider "${providerId}" not available.`);
		const transcribeAudio = provider.transcribeAudio;
		const media = await params.cache.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs
		});
		const { apiKeys, baseUrl, headers } = await resolveProviderExecutionContext({
			providerId,
			cfg,
			entry,
			config: params.config,
			agentDir: params.agentDir
		});
		const providerQuery = resolveProviderQuery({
			providerId,
			config: params.config,
			entry
		});
		const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;
		const result = await executeWithApiKeyRotation({
			provider: providerId,
			apiKeys,
			execute: async (apiKey) => transcribeAudio({
				buffer: media.buffer,
				fileName: media.fileName,
				mime: media.mime,
				apiKey,
				baseUrl,
				headers,
				model,
				language: entry.language ?? params.config?.language ?? cfg.tools?.media?.audio?.language,
				prompt,
				query: providerQuery,
				timeoutMs
			})
		});
		return {
			kind: "audio.transcription",
			attachmentIndex: params.attachmentIndex,
			text: trimOutput(result.text, maxChars),
			provider: providerId,
			model: result.model ?? model
		};
	}
	if (!provider.describeVideo) throw new Error(`Video understanding provider "${providerId}" not available.`);
	const describeVideo = provider.describeVideo;
	const media = await params.cache.getBuffer({
		attachmentIndex: params.attachmentIndex,
		maxBytes,
		timeoutMs
	});
	const estimatedBase64Bytes = estimateBase64Size(media.size);
	const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
	if (estimatedBase64Bytes > maxBase64Bytes) throw new MediaUnderstandingSkipError("maxBytes", `Video attachment ${params.attachmentIndex + 1} base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`);
	const { apiKeys, baseUrl, headers } = await resolveProviderExecutionContext({
		providerId,
		cfg,
		entry,
		config: params.config,
		agentDir: params.agentDir
	});
	const result = await executeWithApiKeyRotation({
		provider: providerId,
		apiKeys,
		execute: (apiKey) => describeVideo({
			buffer: media.buffer,
			fileName: media.fileName,
			mime: media.mime,
			apiKey,
			baseUrl,
			headers,
			model: entry.model,
			prompt,
			timeoutMs
		})
	});
	return {
		kind: "video.description",
		attachmentIndex: params.attachmentIndex,
		text: trimOutput(result.text, maxChars),
		provider: providerId,
		model: result.model ?? entry.model
	};
}
async function runCliEntry(params) {
	const { entry, capability, cfg, ctx } = params;
	const command = entry.command?.trim();
	const args = entry.args ?? [];
	if (!command) throw new Error(`CLI entry missing command for ${capability}`);
	const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
		capability,
		entry,
		cfg,
		config: params.config
	});
	const pathResult = await params.cache.getPath({
		attachmentIndex: params.attachmentIndex,
		maxBytes,
		timeoutMs
	});
	const outputDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-cli-"));
	const mediaPath = pathResult.path;
	const outputBase = path.join(outputDir, path.parse(mediaPath).name);
	const templCtx = {
		...ctx,
		MediaPath: mediaPath,
		MediaDir: path.dirname(mediaPath),
		OutputDir: outputDir,
		OutputBase: outputBase,
		Prompt: prompt,
		MaxChars: maxChars
	};
	const argv = [command, ...args].map((part, index) => index === 0 ? part : applyTemplate(part, templCtx));
	try {
		if (shouldLogVerbose()) logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
		const { stdout } = await runExec(argv[0], argv.slice(1), {
			timeoutMs,
			maxBuffer: CLI_OUTPUT_MAX_BUFFER
		});
		const text = trimOutput(await resolveCliOutput({
			command,
			args: argv.slice(1),
			stdout,
			mediaPath
		}), maxChars);
		if (!text) return null;
		return {
			kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
			attachmentIndex: params.attachmentIndex,
			text,
			provider: "cli",
			model: command
		};
	} finally {
		await fs.rm(outputDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}

//#endregion
//#region src/media-understanding/runner.ts
function buildProviderRegistry(overrides) {
	return buildMediaUnderstandingRegistry(overrides);
}
function normalizeMediaAttachments(ctx) {
	return normalizeAttachments(ctx);
}
function resolveMediaAttachmentLocalRoots(params) {
	return mergeInboundPathRoots(getDefaultMediaLocalRoots(), resolveIMessageAttachmentRoots({
		cfg: params.cfg,
		accountId: params.ctx.AccountId
	}));
}
function createMediaAttachmentCache(attachments, options) {
	return new MediaAttachmentCache(attachments, options);
}
const binaryCache = /* @__PURE__ */ new Map();
const geminiProbeCache = /* @__PURE__ */ new Map();
function expandHomeDir(value) {
	if (!value.startsWith("~")) return value;
	const home = os.homedir();
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}
function hasPathSeparator(value) {
	return value.includes("/") || value.includes("\\");
}
function candidateBinaryNames(name) {
	if (process.platform !== "win32") return [name];
	if (path.extname(name)) return [name];
	const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((item) => item.trim()).filter(Boolean).map((item) => item.startsWith(".") ? item : `.${item}`);
	return [name, ...Array.from(new Set(pathext)).map((item) => `${name}${item}`)];
}
async function isExecutable(filePath) {
	try {
		if (!(await fs.stat(filePath)).isFile()) return false;
		if (process.platform === "win32") return true;
		await fs.access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function findBinary(name) {
	const cached = binaryCache.get(name);
	if (cached) return cached;
	const resolved = (async () => {
		const direct = expandHomeDir(name.trim());
		if (direct && hasPathSeparator(direct)) {
			for (const candidate of candidateBinaryNames(direct)) if (await isExecutable(candidate)) return candidate;
		}
		const searchName = name.trim();
		if (!searchName) return null;
		const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
		const candidates = candidateBinaryNames(searchName);
		for (const entryRaw of pathEntries) {
			const entry = expandHomeDir(entryRaw.trim().replace(/^"(.*)"$/, "$1"));
			if (!entry) continue;
			for (const candidate of candidates) {
				const fullPath = path.join(entry, candidate);
				if (await isExecutable(fullPath)) return fullPath;
			}
		}
		return null;
	})();
	binaryCache.set(name, resolved);
	return resolved;
}
async function hasBinary(name) {
	return Boolean(await findBinary(name));
}
async function probeGeminiCli() {
	const cached = geminiProbeCache.get("gemini");
	if (cached) return cached;
	const resolved = (async () => {
		if (!await hasBinary("gemini")) return false;
		try {
			const { stdout } = await runExec("gemini", [
				"--output-format",
				"json",
				"ok"
			], { timeoutMs: 8e3 });
			return Boolean(extractGeminiResponse(stdout) ?? stdout.toLowerCase().includes("ok"));
		} catch {
			return false;
		}
	})();
	geminiProbeCache.set("gemini", resolved);
	return resolved;
}
async function resolveLocalWhisperCppEntry() {
	if (!await hasBinary("whisper-cli")) return null;
	const envModel = process.env.WHISPER_CPP_MODEL?.trim();
	const modelPath = envModel && await fileExists(envModel) ? envModel : "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
	if (!await fileExists(modelPath)) return null;
	return {
		type: "cli",
		command: "whisper-cli",
		args: [
			"-m",
			modelPath,
			"-otxt",
			"-of",
			"{{OutputBase}}",
			"-np",
			"-nt",
			"{{MediaPath}}"
		]
	};
}
async function resolveLocalWhisperEntry() {
	if (!await hasBinary("whisper")) return null;
	return {
		type: "cli",
		command: "whisper",
		args: [
			"--model",
			"turbo",
			"--output_format",
			"txt",
			"--output_dir",
			"{{OutputDir}}",
			"--verbose",
			"False",
			"{{MediaPath}}"
		]
	};
}
async function resolveSherpaOnnxEntry() {
	if (!await hasBinary("sherpa-onnx-offline")) return null;
	const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
	if (!modelDir) return null;
	const tokens = path.join(modelDir, "tokens.txt");
	const encoder = path.join(modelDir, "encoder.onnx");
	const decoder = path.join(modelDir, "decoder.onnx");
	const joiner = path.join(modelDir, "joiner.onnx");
	if (!await fileExists(tokens)) return null;
	if (!await fileExists(encoder)) return null;
	if (!await fileExists(decoder)) return null;
	if (!await fileExists(joiner)) return null;
	return {
		type: "cli",
		command: "sherpa-onnx-offline",
		args: [
			`--tokens=${tokens}`,
			`--encoder=${encoder}`,
			`--decoder=${decoder}`,
			`--joiner=${joiner}`,
			"{{MediaPath}}"
		]
	};
}
async function resolveLocalAudioEntry() {
	const sherpa = await resolveSherpaOnnxEntry();
	if (sherpa) return sherpa;
	const whisperCpp = await resolveLocalWhisperCppEntry();
	if (whisperCpp) return whisperCpp;
	return await resolveLocalWhisperEntry();
}
async function resolveGeminiCliEntry(_capability) {
	if (!await probeGeminiCli()) return null;
	return {
		type: "cli",
		command: "gemini",
		args: [
			"--output-format",
			"json",
			"--allowed-tools",
			"read_many_files",
			"--include-directories",
			"{{MediaDir}}",
			"{{Prompt}}",
			"Use read_many_files to read {{MediaPath}} and respond with only the text output."
		]
	};
}
async function resolveKeyEntry(params) {
	const { cfg, agentDir, providerRegistry, capability } = params;
	const checkProvider = async (providerId, model) => {
		const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
		if (!provider) return null;
		if (capability === "audio" && !provider.transcribeAudio) return null;
		if (capability === "image" && !provider.describeImage) return null;
		if (capability === "video" && !provider.describeVideo) return null;
		try {
			await resolveApiKeyForProvider({
				provider: providerId,
				cfg,
				agentDir
			});
			return {
				type: "provider",
				provider: providerId,
				model
			};
		} catch {
			return null;
		}
	};
	if (capability === "image") {
		const activeProvider = params.activeModel?.provider?.trim();
		if (activeProvider) {
			const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
			if (activeEntry) return activeEntry;
		}
		for (const providerId of AUTO_IMAGE_KEY_PROVIDERS) {
			const model = DEFAULT_IMAGE_MODELS[providerId];
			const entry = await checkProvider(providerId, model);
			if (entry) return entry;
		}
		return null;
	}
	if (capability === "video") {
		const activeProvider = params.activeModel?.provider?.trim();
		if (activeProvider) {
			const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
			if (activeEntry) return activeEntry;
		}
		for (const providerId of AUTO_VIDEO_KEY_PROVIDERS) {
			const entry = await checkProvider(providerId, void 0);
			if (entry) return entry;
		}
		return null;
	}
	const activeProvider = params.activeModel?.provider?.trim();
	if (activeProvider) {
		const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
		if (activeEntry) return activeEntry;
	}
	for (const providerId of AUTO_AUDIO_KEY_PROVIDERS) {
		const entry = await checkProvider(providerId, void 0);
		if (entry) return entry;
	}
	return null;
}
function resolveImageModelFromAgentDefaults(cfg) {
	const refs = [];
	const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel);
	if (primary?.trim()) refs.push(primary.trim());
	for (const fb of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) if (fb?.trim()) refs.push(fb.trim());
	if (refs.length === 0) return [];
	const entries = [];
	for (const ref of refs) {
		const slashIdx = ref.indexOf("/");
		if (slashIdx <= 0 || slashIdx >= ref.length - 1) continue;
		entries.push({
			type: "provider",
			provider: ref.slice(0, slashIdx),
			model: ref.slice(slashIdx + 1)
		});
	}
	return entries;
}
async function resolveAutoEntries(params) {
	const activeEntry = await resolveActiveModelEntry(params);
	if (activeEntry) return [activeEntry];
	if (params.capability === "audio") {
		const localAudio = await resolveLocalAudioEntry();
		if (localAudio) return [localAudio];
	}
	if (params.capability === "image") {
		const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
		if (imageModelEntries.length > 0) return imageModelEntries;
	}
	const gemini = await resolveGeminiCliEntry(params.capability);
	if (gemini) return [gemini];
	const keys = await resolveKeyEntry(params);
	if (keys) return [keys];
	return [];
}
async function resolveAutoImageModel(params) {
	const providerRegistry = buildProviderRegistry();
	const toActive = (entry) => {
		if (!entry || entry.type === "cli") return null;
		const provider = entry.provider;
		if (!provider) return null;
		const model = entry.model ?? DEFAULT_IMAGE_MODELS[provider];
		if (!model) return null;
		return {
			provider,
			model
		};
	};
	const resolvedActive = toActive(await resolveActiveModelEntry({
		cfg: params.cfg,
		agentDir: params.agentDir,
		providerRegistry,
		capability: "image",
		activeModel: params.activeModel
	}));
	if (resolvedActive) return resolvedActive;
	return toActive(await resolveKeyEntry({
		cfg: params.cfg,
		agentDir: params.agentDir,
		providerRegistry,
		capability: "image",
		activeModel: params.activeModel
	}));
}
async function resolveActiveModelEntry(params) {
	const activeProviderRaw = params.activeModel?.provider?.trim();
	if (!activeProviderRaw) return null;
	const providerId = normalizeMediaProviderId(activeProviderRaw);
	if (!providerId) return null;
	const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
	if (!provider) return null;
	if (params.capability === "audio" && !provider.transcribeAudio) return null;
	if (params.capability === "image" && !provider.describeImage) return null;
	if (params.capability === "video" && !provider.describeVideo) return null;
	try {
		await resolveApiKeyForProvider({
			provider: providerId,
			cfg: params.cfg,
			agentDir: params.agentDir
		});
	} catch {
		return null;
	}
	return {
		type: "provider",
		provider: providerId,
		model: params.activeModel?.model
	};
}
async function runAttachmentEntries(params) {
	const { entries, capability } = params;
	const attempts = [];
	for (const entry of entries) {
		const entryType = entry.type ?? (entry.command ? "cli" : "provider");
		try {
			const result = entryType === "cli" ? await runCliEntry({
				capability,
				entry,
				cfg: params.cfg,
				ctx: params.ctx,
				attachmentIndex: params.attachmentIndex,
				cache: params.cache,
				config: params.config
			}) : await runProviderEntry({
				capability,
				entry,
				cfg: params.cfg,
				ctx: params.ctx,
				attachmentIndex: params.attachmentIndex,
				cache: params.cache,
				agentDir: params.agentDir,
				providerRegistry: params.providerRegistry,
				config: params.config
			});
			if (result) {
				const decision = buildModelDecision({
					entry,
					entryType,
					outcome: "success"
				});
				if (result.provider) decision.provider = result.provider;
				if (result.model) decision.model = result.model;
				attempts.push(decision);
				return {
					output: result,
					attempts
				};
			}
			attempts.push(buildModelDecision({
				entry,
				entryType,
				outcome: "skipped",
				reason: "empty output"
			}));
		} catch (err) {
			if (isMediaUnderstandingSkipError(err)) {
				attempts.push(buildModelDecision({
					entry,
					entryType,
					outcome: "skipped",
					reason: `${err.reason}: ${err.message}`
				}));
				if (shouldLogVerbose()) logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
				continue;
			}
			attempts.push(buildModelDecision({
				entry,
				entryType,
				outcome: "failed",
				reason: String(err)
			}));
			if (shouldLogVerbose()) logVerbose(`${capability} understanding failed: ${String(err)}`);
		}
	}
	return {
		output: null,
		attempts
	};
}
async function runCapability(params) {
	const { capability, cfg, ctx } = params;
	const config = params.config ?? cfg.tools?.media?.[capability];
	if (config?.enabled === false) return {
		outputs: [],
		decision: {
			capability,
			outcome: "disabled",
			attachments: []
		}
	};
	const attachmentPolicy = config?.attachments;
	const selected = selectAttachments({
		capability,
		attachments: params.media,
		policy: attachmentPolicy
	});
	if (selected.length === 0) return {
		outputs: [],
		decision: {
			capability,
			outcome: "no-attachment",
			attachments: []
		}
	};
	if (resolveScopeDecision({
		scope: config?.scope,
		ctx
	}) === "deny") {
		if (shouldLogVerbose()) logVerbose(`${capability} understanding disabled by scope policy.`);
		return {
			outputs: [],
			decision: {
				capability,
				outcome: "scope-deny",
				attachments: selected.map((item) => ({
					attachmentIndex: item.index,
					attempts: []
				}))
			}
		};
	}
	const activeProvider = params.activeModel?.provider?.trim();
	if (capability === "image" && activeProvider) {
		if (modelSupportsVision(findModelInCatalog(await loadModelCatalog({ config: cfg }), activeProvider, params.activeModel?.model ?? ""))) {
			if (shouldLogVerbose()) logVerbose("Skipping image understanding: primary model supports vision natively");
			const model = params.activeModel?.model?.trim();
			const reason = "primary model supports vision natively";
			return {
				outputs: [],
				decision: {
					capability,
					outcome: "skipped",
					attachments: selected.map((item) => {
						const attempt = {
							type: "provider",
							provider: activeProvider,
							model: model || void 0,
							outcome: "skipped",
							reason
						};
						return {
							attachmentIndex: item.index,
							attempts: [attempt],
							chosen: attempt
						};
					})
				}
			};
		}
	}
	let resolvedEntries = resolveModelEntries({
		cfg,
		capability,
		config,
		providerRegistry: params.providerRegistry
	});
	if (resolvedEntries.length === 0) resolvedEntries = await resolveAutoEntries({
		cfg,
		agentDir: params.agentDir,
		providerRegistry: params.providerRegistry,
		capability,
		activeModel: params.activeModel
	});
	if (resolvedEntries.length === 0) return {
		outputs: [],
		decision: {
			capability,
			outcome: "skipped",
			attachments: selected.map((item) => ({
				attachmentIndex: item.index,
				attempts: []
			}))
		}
	};
	const outputs = [];
	const attachmentDecisions = [];
	for (const attachment of selected) {
		const { output, attempts } = await runAttachmentEntries({
			capability,
			cfg,
			ctx,
			attachmentIndex: attachment.index,
			agentDir: params.agentDir,
			providerRegistry: params.providerRegistry,
			cache: params.attachments,
			entries: resolvedEntries,
			config
		});
		if (output) outputs.push(output);
		attachmentDecisions.push({
			attachmentIndex: attachment.index,
			attempts,
			chosen: attempts.find((attempt) => attempt.outcome === "success")
		});
	}
	const decision = {
		capability,
		outcome: outputs.length > 0 ? "success" : "skipped",
		attachments: attachmentDecisions
	};
	if (shouldLogVerbose()) logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
	return {
		outputs,
		decision
	};
}

//#endregion
export { resolveMediaUnderstandingScope as _, resolveMediaAttachmentLocalRoots as a, loadModelCatalog as c, resolveAttachmentKind as d, buildRandomTempFilePath as f, normalizeMediaUnderstandingChatType as g, resolveTimeoutMs as h, resolveAutoImageModel as i, modelSupportsVision as l, resolveConcurrency as m, createMediaAttachmentCache as n, runCapability as o, registerUnhandledRejectionHandler as p, normalizeMediaAttachments as r, findModelInCatalog as s, buildProviderRegistry as t, isAudioAttachment as u, CLI_OUTPUT_MAX_BUFFER as v, applyTemplate as y };