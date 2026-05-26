import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { l as sanitizeConfiguredModelProviderRequest } from "./provider-request-config-DxK6PUHR.js";
import { u as resolveClosestSize } from "./runtime-shared-CXEq0Bjh.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, l as postMultipartRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as isPrivateNetworkOptInEnabled } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-mime-j2Nhr7Df.js";
import "./media-generation-runtime-CiSN_AhM.js";
import "./logging-core-DwEC9Ajh.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { c as parseOpenAiCompatibleImageResponse, u as toImageDataUrl } from "./image-generation-Bda4L-l6.js";
import { n as canonicalizeCodexResponsesBaseUrl, t as OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url-UKY1cn1G.js";
import { i as OPENAI_DEFAULT_IMAGE_MODEL } from "./default-models-9Fo5IjIh.js";
import { r as resolveConfiguredOpenAIBaseUrl } from "./shared-CrBPnArW.js";
import path from "node:path";
//#region extensions/openai/image-generation-provider.ts
const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.5";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 18e4;
const DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS = 6e5;
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_OUTPUT_EXTENSION = "png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
	"1024x1024",
	"1536x1024",
	"1024x1536",
	"2048x2048",
	"2048x1152",
	"3840x2160",
	"2160x3840"
];
const OPENAI_LEGACY_IMAGE_SIZES = [
	"1024x1024",
	"1536x1024",
	"1024x1536"
];
const OPENAI_MAX_INPUT_IMAGES = 5;
const OPENAI_MAX_IMAGE_RESULTS = 4;
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const LOG_VALUE_MAX_CHARS = 256;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";
const OPENAI_OUTPUT_FORMATS = [
	"png",
	"jpeg",
	"webp"
];
const OPENAI_BACKGROUNDS = [
	"transparent",
	"opaque",
	"auto"
];
const OPENAI_QUALITIES = [
	"low",
	"medium",
	"high",
	"auto"
];
const OPENAI_IMAGE_MODELS = [
	OPENAI_DEFAULT_IMAGE_MODEL,
	OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
	"gpt-image-1",
	"gpt-image-1-mini"
];
const log = createSubsystemLogger("image-generation/openai");
const AZURE_HOSTNAME_SUFFIXES = [
	".openai.azure.com",
	".services.ai.azure.com",
	".cognitiveservices.azure.com"
];
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";
function sanitizeLogValue(value) {
	const cleaned = (typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "unknown";
	return cleaned.length > LOG_VALUE_MAX_CHARS ? `${cleaned.slice(0, LOG_VALUE_MAX_CHARS)}...` : cleaned;
}
function resolveOpenAIImageTimeoutMs(timeoutMs, options) {
	return timeoutMs ?? (options?.isAzure ? DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS : DEFAULT_OPENAI_IMAGE_TIMEOUT_MS);
}
function resolveOpenAIImageCount(count) {
	if (typeof count !== "number" || !Number.isFinite(count)) return 1;
	return Math.max(1, Math.min(OPENAI_MAX_IMAGE_RESULTS, Math.trunc(count)));
}
function isPublicOpenAIImageBaseUrl(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return false;
	try {
		const parsed = new URL(trimmed);
		const pathName = parsed.pathname.replace(/\/+$/, "");
		return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.openai.com" && parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" && pathName === "/v1";
	} catch {
		return false;
	}
}
function isAzureOpenAIBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return false;
	try {
		const hostname = new URL(trimmed).hostname.toLowerCase();
		return AZURE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
	} catch {
		return false;
	}
}
function resolveAzureApiVersion() {
	return process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}
function buildAzureImageUrl(rawBaseUrl, model, action) {
	return `${rawBaseUrl.replace(/\/+$/, "").replace(/\/openai\/v1$/, "").replace(/\/v1$/, "")}/openai/deployments/${model}/images/${action}?api-version=${resolveAzureApiVersion()}`;
}
function resolveOutputMime(outputFormat) {
	switch (outputFormat) {
		case "jpeg": return {
			mimeType: "image/jpeg",
			extension: "jpg"
		};
		case "webp": return {
			mimeType: "image/webp",
			extension: "webp"
		};
		case "png":
		case void 0: return {
			mimeType: DEFAULT_OUTPUT_MIME,
			extension: DEFAULT_OUTPUT_EXTENSION
		};
	}
	return {
		mimeType: DEFAULT_OUTPUT_MIME,
		extension: DEFAULT_OUTPUT_EXTENSION
	};
}
function appendOpenAIImageOptions(target, req) {
	const openai = req.providerOptions?.openai;
	const background = openai?.background ?? req.background;
	const entries = {
		...req.quality !== void 0 ? { quality: req.quality } : {},
		...req.outputFormat !== void 0 ? { output_format: req.outputFormat } : {},
		...background !== void 0 ? { background } : {},
		...openai?.moderation !== void 0 ? { moderation: openai.moderation } : {},
		...openai?.outputCompression !== void 0 ? { output_compression: openai.outputCompression } : {},
		...openai?.user !== void 0 ? { user: openai.user } : {}
	};
	for (const [key, value] of Object.entries(entries)) if (target instanceof FormData) target.set(key, String(value));
	else target[key] = value;
}
function resolveOpenAIImageRequestModel(req, options) {
	const model = req.model || "gpt-image-2";
	if (options?.allowTransparentDefaultReroute === true && model === "gpt-image-2" && (req.providerOptions?.openai?.background ?? req.background) === "transparent") return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
	return model;
}
function resolveNativeOpenAIImageSizesForModel(model) {
	switch (model) {
		case "gpt-image-1":
		case "gpt-image-1-mini": return OPENAI_LEGACY_IMAGE_SIZES;
		default: return OPENAI_SUPPORTED_SIZES;
	}
}
function resolveOpenAIImageRequestSize(params) {
	const requestedSize = params.requestedSize ?? DEFAULT_SIZE;
	if (!params.applyNativeLimits) return { size: requestedSize };
	const size = resolveClosestSize({
		requestedSize,
		supportedSizes: resolveNativeOpenAIImageSizesForModel(params.model)
	}) ?? DEFAULT_SIZE;
	if (size === requestedSize) return { size };
	return {
		size,
		metadata: {
			requestedSize,
			normalizedSize: size
		}
	};
}
function shouldAllowPrivateImageEndpoint(req) {
	if (req.provider === MOCK_OPENAI_PROVIDER_ID) return true;
	if (isPrivateNetworkOptInEnabled(req.cfg?.browser?.ssrfPolicy)) return true;
	const baseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
	if (!baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) return false;
	return process.env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER === "1";
}
function normalizeProviderId(value) {
	return value?.trim().toLowerCase() ?? "";
}
function hasExplicitOpenAIDirectAuthConfig(cfg) {
	const profiles = cfg?.auth?.profiles;
	if (!profiles) return false;
	return Object.values(profiles).some((profile) => normalizeProviderId(profile.provider) === "openai");
}
function hasExplicitOpenAIDirectProviderConfig(cfg) {
	if (hasExplicitOpenAIDirectAuthConfig(cfg)) return true;
	const providerConfig = cfg?.models?.providers?.openai;
	if (!providerConfig) return false;
	if (providerConfig.apiKey !== void 0) return true;
	const configuredBaseUrl = resolveConfiguredOpenAIBaseUrl(cfg);
	if (configuredBaseUrl.trim() && configuredBaseUrl.replace(/\/+$/, "") !== DEFAULT_OPENAI_IMAGE_BASE_URL) return true;
	if (providerConfig.api !== void 0) return true;
	if (providerConfig.headers && Object.keys(providerConfig.headers).length > 0) return true;
	if (providerConfig.authHeader === false || providerConfig.request !== void 0) return true;
	return false;
}
function resolveRequestAuthStore(req) {
	if (req.authStore) return req.authStore;
	const agentDir = req.agentDir?.trim();
	if (!agentDir) return;
	return ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
}
function hasCodexOAuthProfileConfigured(req) {
	const store = resolveRequestAuthStore(req);
	return Boolean(store && listProfilesForProvider(store, "openai-codex").length > 0);
}
function inferImageUploadFileName(params) {
	const fileName = params.fileName?.trim();
	if (fileName) return path.basename(fileName);
	const ext = extensionForMime(params.mimeType?.trim().toLowerCase() || DEFAULT_OUTPUT_MIME)?.slice(1) ?? "png";
	return `image-${params.index + 1}.${ext}`;
}
async function readResponseBodyText(response) {
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_CODEX_IMAGE_SSE_BYTES) throw new Error("OpenAI Codex image generation response exceeded size limit");
		return text;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks = [];
	let byteLength = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value) {
				byteLength += value.byteLength;
				if (byteLength > MAX_CODEX_IMAGE_SSE_BYTES) throw new Error("OpenAI Codex image generation response exceeded size limit");
				chunks.push(decoder.decode(value, { stream: !done }));
			}
			if (done) {
				const tail = decoder.decode();
				if (tail) chunks.push(tail);
				return chunks.join("");
			}
		}
	} finally {
		reader.releaseLock();
	}
}
function parseCodexImageGenerationEvents(body) {
	const events = [];
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			continue;
		}
		events.push(event);
		if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) throw new Error("OpenAI Codex image generation response exceeded event limit");
	}
	return events;
}
function decodeCodexImagePayload(payload) {
	if (payload.length > MAX_CODEX_IMAGE_BASE64_CHARS) throw new Error("OpenAI Codex image generation result exceeded size limit");
	return Buffer.from(payload, "base64");
}
function toCodexImage(entry, index, outputFormat) {
	if (typeof entry.result !== "string" || entry.result.length === 0) return null;
	const output = resolveOutputMime(outputFormat);
	return Object.assign({
		buffer: decodeCodexImagePayload(entry.result),
		mimeType: output.mimeType,
		fileName: `image-${index + 1}.${output.extension}`
	}, entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {});
}
function extractCodexImageGenerationResult(params) {
	const events = parseCodexImageGenerationEvents(params.body);
	const failure = events.find((event) => event.type === "response.failed" || event.type === "error");
	if (failure) {
		const message = failure.error?.message ?? failure.message ?? (failure.error?.code ? `OpenAI Codex image generation failed (${failure.error.code})` : "");
		throw new Error(message || "OpenAI Codex image generation failed");
	}
	const completedResponse = events.find((event) => event.type === "response.completed");
	const outputItemImages = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "image_generation_call" && typeof event.item.result === "string" && event.item.result.length > 0).slice(0, OPENAI_MAX_IMAGE_RESULTS).map((event, index) => event.item ? toCodexImage(event.item, index, params.outputFormat) : null).filter((image) => image !== null);
	const completedOutputImages = (completedResponse?.response?.output ?? []).filter((entry) => entry.type === "image_generation_call").slice(0, OPENAI_MAX_IMAGE_RESULTS).map((entry, index) => toCodexImage(entry, index, params.outputFormat)).filter((image) => image !== null);
	return {
		images: outputItemImages.length > 0 ? outputItemImages : completedOutputImages,
		model: params.model,
		...completedResponse?.response ? { metadata: {
			usage: completedResponse.response.usage,
			toolUsage: completedResponse.response.tool_usage
		} } : {}
	};
}
function createOpenAIImageGenerationProviderBase(params) {
	return {
		id: params.id,
		aliases: ["openai-codex"],
		label: params.label,
		defaultModel: OPENAI_DEFAULT_IMAGE_MODEL,
		models: [...OPENAI_IMAGE_MODELS],
		isConfigured: params.isConfigured,
		capabilities: {
			generate: {
				maxCount: 4,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			edit: {
				enabled: true,
				maxCount: 4,
				maxInputImages: OPENAI_MAX_INPUT_IMAGES,
				supportsSize: true,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			geometry: { sizes: [...OPENAI_SUPPORTED_SIZES] },
			output: {
				formats: [...OPENAI_OUTPUT_FORMATS],
				qualities: [...OPENAI_QUALITIES],
				backgrounds: [...OPENAI_BACKGROUNDS]
			}
		},
		generateImage: params.generateImage
	};
}
async function resolveOptionalApiKeyForProvider(params) {
	try {
		return await resolveApiKeyForProvider(params);
	} catch (error) {
		const provider = params?.provider ?? "";
		if (!(error instanceof Error ? error.message : "").startsWith(`No API key found for provider "${provider}".`)) throw error;
		return null;
	}
}
function logCodexImageAuthSelected(params) {
	const model = resolveOpenAIImageRequestModel(params.req, { allowTransparentDefaultReroute: true });
	log.info(`image auth selected: provider=openai-codex mode=${sanitizeLogValue(params.authMode)} transport=codex-responses requestedModel=${sanitizeLogValue(model)} responsesModel=${DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL} timeoutMs=${params.timeoutMs}`);
}
async function generateOpenAICodexImage(params) {
	const { req, apiKey } = params;
	const inputImages = req.inputImages ?? [];
	const codexProviderConfig = req.cfg?.models?.providers?.["openai-codex"];
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: canonicalizeCodexResponsesBaseUrl(codexProviderConfig?.baseUrl),
		defaultBaseUrl: DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL,
		defaultHeaders: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "text/event-stream"
		},
		request: sanitizeConfiguredModelProviderRequest(codexProviderConfig?.request),
		provider: "openai-codex",
		api: "openai-codex-responses",
		capability: "image",
		transport: "http"
	});
	const model = resolveOpenAIImageRequestModel(req, { allowTransparentDefaultReroute: true });
	const count = resolveOpenAIImageCount(req.count);
	const sizeResolution = resolveOpenAIImageRequestSize({
		model,
		requestedSize: req.size,
		applyNativeLimits: true
	});
	const size = sizeResolution.size;
	const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
	const openai = req.providerOptions?.openai;
	const background = openai?.background ?? req.background;
	headers.set("Content-Type", "application/json");
	const content = [{
		type: "input_text",
		text: req.prompt
	}, ...inputImages.map((image) => ({
		type: "input_image",
		image_url: toImageDataUrl({
			buffer: image.buffer,
			mimeType: image.mimeType
		}),
		detail: "auto"
	}))];
	const results = [];
	for (let index = 0; index < count; index += 1) {
		const { response, release } = await postJsonRequest({
			url: `${baseUrl}/responses`,
			headers,
			body: {
				model: DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL,
				input: [{
					role: "user",
					content
				}],
				instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
				tools: [{
					type: "image_generation",
					model,
					size,
					...req.quality !== void 0 ? { quality: req.quality } : {},
					...req.outputFormat !== void 0 ? { output_format: req.outputFormat } : {},
					...background !== void 0 ? { background } : {},
					...openai?.outputCompression !== void 0 ? { output_compression: openai.outputCompression } : {}
				}],
				tool_choice: { type: "image_generation" },
				stream: true,
				store: false
			},
			timeoutMs,
			fetchFn: fetch,
			allowPrivateNetwork,
			ssrfPolicy: req.ssrfPolicy,
			dispatcherPolicy
		});
		try {
			await assertOkOrThrowHttpError(response, "OpenAI Codex image generation failed");
			results.push(extractCodexImageGenerationResult({
				body: await readResponseBodyText(response),
				model,
				outputFormat: req.outputFormat
			}));
		} finally {
			await release();
		}
	}
	const images = results.flatMap((result) => result.images);
	const output = resolveOutputMime(req.outputFormat);
	return {
		images: images.map((image, index) => Object.assign({}, image, { fileName: `image-${index + 1}.${output.extension}` })),
		model,
		metadata: {
			...sizeResolution.metadata,
			responses: results.map((result) => result.metadata).filter(Boolean)
		}
	};
}
function buildOpenAIImageGenerationProvider() {
	return createOpenAIImageGenerationProviderBase({
		id: "openai",
		label: "OpenAI",
		isConfigured: ({ cfg, agentDir }) => {
			if (isProviderApiKeyConfigured({
				provider: "openai",
				agentDir
			})) return true;
			if (!isPublicOpenAIImageBaseUrl(resolveConfiguredOpenAIBaseUrl(cfg))) return false;
			return isProviderApiKeyConfigured({
				provider: "openai-codex",
				agentDir
			});
		},
		async generateImage(req) {
			const inputImages = req.inputImages ?? [];
			const isEdit = inputImages.length > 0;
			const rawBaseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
			const publicOpenAIBaseUrl = isPublicOpenAIImageBaseUrl(rawBaseUrl);
			if (publicOpenAIBaseUrl && !hasExplicitOpenAIDirectProviderConfig(req.cfg) && hasCodexOAuthProfileConfigured(req)) {
				const codexAuth = await resolveApiKeyForProvider({
					provider: "openai-codex",
					cfg: req.cfg,
					agentDir: req.agentDir,
					store: req.authStore
				});
				if (!codexAuth.apiKey) throw new Error("OpenAI Codex OAuth missing");
				const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
				logCodexImageAuthSelected({
					req,
					authMode: codexAuth.mode,
					timeoutMs
				});
				return generateOpenAICodexImage({
					req,
					apiKey: codexAuth.apiKey
				});
			}
			const auth = await resolveOptionalApiKeyForProvider({
				provider: "openai",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth?.apiKey) {
				if (!publicOpenAIBaseUrl) throw new Error("OpenAI API key missing");
				const codexAuth = await resolveOptionalApiKeyForProvider({
					provider: "openai-codex",
					cfg: req.cfg,
					agentDir: req.agentDir,
					store: req.authStore
				});
				if (codexAuth?.apiKey) {
					const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
					logCodexImageAuthSelected({
						req,
						authMode: codexAuth.mode,
						timeoutMs
					});
					return generateOpenAICodexImage({
						req,
						apiKey: codexAuth.apiKey
					});
				}
				throw new Error("OpenAI API key or Codex OAuth missing");
			}
			const isAzure = isAzureOpenAIBaseUrl(rawBaseUrl);
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: rawBaseUrl,
				defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
				allowPrivateNetwork: shouldAllowPrivateImageEndpoint(req),
				defaultHeaders: isAzure ? { "api-key": auth.apiKey } : { Authorization: `Bearer ${auth.apiKey}` },
				provider: "openai",
				capability: "image",
				transport: "http"
			});
			const model = resolveOpenAIImageRequestModel(req, { allowTransparentDefaultReroute: publicOpenAIBaseUrl });
			const count = resolveOpenAIImageCount(req.count);
			const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs, { isAzure });
			const sizeResolution = resolveOpenAIImageRequestSize({
				model,
				requestedSize: req.size,
				applyNativeLimits: publicOpenAIBaseUrl || isAzure
			});
			const size = sizeResolution.size;
			const url = isAzure ? buildAzureImageUrl(rawBaseUrl, model, isEdit ? "edits" : "generations") : `${baseUrl}/images/${isEdit ? "edits" : "generations"}`;
			const { response, release } = isEdit ? await (() => {
				const form = new FormData();
				if (!isAzure) form.set("model", model);
				form.set("prompt", req.prompt);
				form.set("n", String(count));
				form.set("size", size);
				appendOpenAIImageOptions(form, req);
				for (const [index, image] of inputImages.entries()) {
					const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
					form.append("image[]", new Blob([new Uint8Array(image.buffer)], { type: mimeType }), inferImageUploadFileName({
						fileName: image.fileName,
						mimeType,
						index
					}));
				}
				const multipartHeaders = new Headers(headers);
				multipartHeaders.delete("Content-Type");
				return postMultipartRequest({
					url,
					headers: multipartHeaders,
					body: form,
					timeoutMs,
					fetchFn: fetch,
					allowPrivateNetwork,
					ssrfPolicy: req.ssrfPolicy,
					dispatcherPolicy
				});
			})() : await (() => {
				const jsonHeaders = new Headers(headers);
				jsonHeaders.set("Content-Type", "application/json");
				const body = {
					prompt: req.prompt,
					n: count,
					size
				};
				if (!isAzure) body.model = model;
				appendOpenAIImageOptions(body, req);
				return postJsonRequest({
					url,
					headers: jsonHeaders,
					body,
					timeoutMs,
					fetchFn: fetch,
					allowPrivateNetwork,
					ssrfPolicy: req.ssrfPolicy,
					dispatcherPolicy
				});
			})();
			try {
				await assertOkOrThrowHttpError(response, isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed");
				const data = await response.json();
				const output = resolveOutputMime(req.outputFormat);
				const images = parseOpenAiCompatibleImageResponse(data, {
					defaultMimeType: output.mimeType,
					malformedResponseError: isEdit ? "OpenAI image edit response malformed" : "OpenAI image generation response malformed"
				}).map((image, index) => Object.assign(image, { fileName: `image-${index + 1}.${output.extension}` }));
				if (images.length === 0) throw new Error(isEdit ? "OpenAI image edit response missing image data" : "OpenAI image generation response missing image data");
				return {
					images,
					model,
					...sizeResolution.metadata ? { metadata: sizeResolution.metadata } : {}
				};
			} finally {
				await release();
			}
		}
	});
}
//#endregion
export { buildOpenAIImageGenerationProvider as t };
