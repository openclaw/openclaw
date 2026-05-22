import { n as findNormalizedProviderValue } from "./provider-id-DifICj6R.js";
import { b as prepareProviderDynamicModel } from "./provider-runtime-B8Jm9zy4.js";
import { S as normalizeModelRef } from "./model-selection-shared-BBpFqu68.js";
import "./model-selection-BP-YASdB.js";
import { r as resolveProviderRequestCapabilities } from "./provider-attribution-17OsVJTk.js";
import { t as requireApiKey } from "./model-auth-runtime-shared-CtBAvGwJ.js";
import { l as resolveApiKeyForProvider, r as getApiKeyForModel } from "./model-auth-Atvm_2TG.js";
import { n as ensureOpenClawModelsJson } from "./models-config-C31dwAvy.js";
import { t as registerProviderStreamForModel } from "./provider-stream-BZR1oM6s.js";
import { i as coerceImageAssistantText, r as minimaxUnderstandImage, s as hasImageReasoningOnlyResponse, t as isMinimaxVlmModel } from "./minimax-vlm-DFygoMU0.js";
import { r as resolveModelWithRegistry } from "./model-DHzJrk_7.js";
import { complete } from "@mariozechner/pi-ai";
//#region src/media-understanding/image.ts
let piModelDiscoveryRuntimePromise = null;
function loadPiModelDiscoveryRuntime() {
	piModelDiscoveryRuntimePromise ??= import("./agents/pi-model-discovery-runtime.js");
	return piModelDiscoveryRuntimePromise;
}
function resolveImageToolMaxTokens(modelMaxTokens, requestedMaxTokens = 4096) {
	if (typeof modelMaxTokens !== "number" || !Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) return requestedMaxTokens;
	return Math.min(requestedMaxTokens, modelMaxTokens);
}
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNativeResponsesReasoningPayload(model) {
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses" && model.api !== "openai-codex-responses") return false;
	return resolveProviderRequestCapabilities({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		capability: "image",
		transport: "media-understanding"
	}).usesKnownNativeOpenAIRoute;
}
function formatModelInputCapabilities(input) {
	return input && input.length > 0 ? input.join(", ") : "none";
}
function removeReasoningInclude(value) {
	if (!Array.isArray(value)) return value;
	const next = value.filter((entry) => entry !== "reasoning.encrypted_content");
	return next.length > 0 ? next : void 0;
}
function disableReasoningForImageRetryPayload(payload, model) {
	if (!isRecord(payload)) return;
	const next = { ...payload };
	delete next.reasoning;
	delete next.reasoning_effort;
	const include = removeReasoningInclude(next.include);
	if (include === void 0) delete next.include;
	else next.include = include;
	if (isNativeResponsesReasoningPayload(model)) next.reasoning = { effort: "none" };
	return next;
}
function isImageModelNoTextError(err) {
	return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}
function isPromiseLike(value) {
	return Boolean(value) && typeof value.then === "function";
}
function composeImageDescriptionPayloadHandlers(first, second) {
	if (!first) return second;
	if (!second) return first;
	return (payload, payloadModel) => {
		const runSecond = (firstResult) => {
			const secondResult = second(firstResult === void 0 ? payload : firstResult, payloadModel);
			const coerceResult = (resolvedSecond) => resolvedSecond === void 0 ? firstResult : resolvedSecond;
			return isPromiseLike(secondResult) ? Promise.resolve(secondResult).then(coerceResult) : coerceResult(secondResult);
		};
		const firstResult = first(payload, payloadModel);
		if (isPromiseLike(firstResult)) return Promise.resolve(firstResult).then(runSecond);
		return runSecond(firstResult);
	};
}
async function resolveImageRuntime(params) {
	await ensureOpenClawModelsJson(params.cfg, params.agentDir);
	const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
	const authStorage = discoverAuthStorage(params.agentDir);
	const modelRegistry = discoverModels(authStorage, params.agentDir);
	const resolvedRef = normalizeModelRef(params.provider, params.model);
	const configuredProviders = params.cfg.models?.providers;
	const providerConfig = configuredProviders?.[resolvedRef.provider] ?? findNormalizedProviderValue(configuredProviders, resolvedRef.provider);
	let model = resolveModelWithRegistry({
		provider: resolvedRef.provider,
		modelId: resolvedRef.model,
		modelRegistry,
		cfg: params.cfg,
		agentDir: params.agentDir
	});
	if (!model) {
		await prepareProviderDynamicModel({
			provider: resolvedRef.provider,
			config: params.cfg,
			context: {
				config: params.cfg,
				agentDir: params.agentDir,
				provider: resolvedRef.provider,
				modelId: resolvedRef.model,
				modelRegistry,
				providerConfig
			}
		});
		model = resolveModelWithRegistry({
			provider: resolvedRef.provider,
			modelId: resolvedRef.model,
			modelRegistry,
			cfg: params.cfg,
			agentDir: params.agentDir
		});
	}
	if (!model) throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
	if (!model.input?.includes("image")) {
		if (isMinimaxVlmModel(resolvedRef.provider, resolvedRef.model)) throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
		throw new Error(`Model does not support images: ${params.provider}/${params.model} (resolved ${model.provider}/${model.id} input: ${formatModelInputCapabilities(model.input)})`);
	}
	const apiKey = requireApiKey(await getApiKeyForModel({
		model,
		cfg: params.cfg,
		agentDir: params.agentDir,
		profileId: params.profile,
		preferredProfile: params.preferredProfile,
		store: params.authStore
	}), model.provider);
	authStorage.setRuntimeApiKey(model.provider, apiKey);
	return {
		apiKey,
		model
	};
}
function buildImageContext(prompt, images, opts) {
	const imageContent = images.map((image) => ({
		type: "image",
		data: image.buffer.toString("base64"),
		mimeType: image.mime ?? "image/jpeg"
	}));
	const content = opts?.promptInUserContent ? [{
		type: "text",
		text: prompt
	}, ...imageContent] : imageContent;
	return {
		...opts?.promptInUserContent ? {} : { systemPrompt: prompt },
		messages: [{
			role: "user",
			content,
			timestamp: Date.now()
		}]
	};
}
function shouldPlaceImagePromptInUserContent(model) {
	const capabilities = resolveProviderRequestCapabilities({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		capability: "image",
		transport: "media-understanding"
	});
	return capabilities.endpointClass === "openrouter" || model.provider.toLowerCase() === "openrouter" && capabilities.endpointClass === "default";
}
async function describeImagesWithMinimax(params) {
	const responses = [];
	for (const [index, image] of params.images.entries()) {
		const prompt = params.images.length > 1 ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.` : params.prompt;
		const text = await minimaxUnderstandImage({
			apiKey: params.apiKey,
			prompt,
			imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
			modelBaseUrl: params.modelBaseUrl,
			timeoutMs: params.timeoutMs
		});
		responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
	}
	return {
		text: responses.join("\n\n").trim(),
		model: params.modelId
	};
}
function isUnknownModelError(err) {
	return err instanceof Error && /^Unknown model:/i.test(err.message);
}
function resolveConfiguredProviderBaseUrl(cfg, provider) {
	const direct = cfg.models?.providers?.[provider];
	if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) return direct.baseUrl.trim();
}
async function resolveMinimaxVlmFallbackRuntime(params) {
	return {
		apiKey: requireApiKey(await resolveApiKeyForProvider({
			provider: params.provider,
			cfg: params.cfg,
			profileId: params.profile,
			preferredProfile: params.preferredProfile,
			agentDir: params.agentDir
		}), params.provider),
		modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider)
	};
}
function resolveImageDescriptionTimeoutMs(timeoutMs, startedAtMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
	return Math.max(1, Math.floor(timeoutMs - (Date.now() - startedAtMs)));
}
async function withImageDescriptionTimeout(params) {
	if (params.timeoutMs === void 0) return await params.task;
	let timeout;
	try {
		return await Promise.race([params.task, new Promise((_, reject) => {
			timeout = setTimeout(() => {
				params.controller.abort();
				reject(/* @__PURE__ */ new Error(`image description timed out after ${params.timeoutMs}ms`));
			}, params.timeoutMs);
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function describeImagesWithModelInternal(params, options = {}) {
	const prompt = params.prompt ?? "Describe the image.";
	const startedAtMs = Date.now();
	const controller = new AbortController();
	let apiKey;
	let model;
	try {
		const resolved = await withImageDescriptionTimeout({
			controller,
			timeoutMs: resolveImageDescriptionTimeoutMs(params.timeoutMs, startedAtMs),
			task: resolveImageRuntime(params)
		});
		apiKey = resolved.apiKey;
		model = resolved.model;
	} catch (err) {
		if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) throw err;
		const fallback = await resolveMinimaxVlmFallbackRuntime(params);
		return await describeImagesWithMinimax({
			apiKey: fallback.apiKey,
			modelId: params.model,
			modelBaseUrl: fallback.modelBaseUrl,
			prompt,
			timeoutMs: params.timeoutMs,
			images: params.images
		});
	}
	if (isMinimaxVlmModel(model.provider, model.id)) return await describeImagesWithMinimax({
		apiKey,
		modelId: model.id,
		modelBaseUrl: model.baseUrl,
		prompt,
		timeoutMs: params.timeoutMs,
		images: params.images
	});
	registerProviderStreamForModel({
		model,
		cfg: params.cfg,
		agentDir: params.agentDir
	});
	const context = buildImageContext(prompt, params.images, { promptInUserContent: shouldPlaceImagePromptInUserContent(model) });
	const maxTokens = resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512);
	const completeImage = async (onPayload) => {
		const payloadHandler = composeImageDescriptionPayloadHandlers(onPayload, options.onPayload);
		const timeoutMs = resolveImageDescriptionTimeoutMs(params.timeoutMs, startedAtMs);
		return await withImageDescriptionTimeout({
			controller,
			timeoutMs,
			task: complete(model, context, {
				apiKey,
				maxTokens,
				signal: controller.signal,
				...timeoutMs !== void 0 ? { timeoutMs } : {},
				...payloadHandler ? { onPayload: payloadHandler } : {}
			})
		});
	};
	const message = await completeImage();
	try {
		return {
			text: coerceImageAssistantText({
				message,
				provider: model.provider,
				model: model.id
			}),
			model: model.id
		};
	} catch (err) {
		if (!isImageModelNoTextError(err) || !hasImageReasoningOnlyResponse(message)) throw err;
	}
	return {
		text: coerceImageAssistantText({
			message: await completeImage(disableReasoningForImageRetryPayload),
			provider: model.provider,
			model: model.id
		}),
		model: model.id
	};
}
async function describeImagesWithModel(params) {
	return await describeImagesWithModelInternal(params);
}
async function describeImagesWithModelPayloadTransform(params, onPayload) {
	return await describeImagesWithModelInternal(params, { onPayload });
}
async function describeImageWithModel(params) {
	return await describeImagesWithModel({
		images: [{
			buffer: params.buffer,
			fileName: params.fileName,
			mime: params.mime
		}],
		model: params.model,
		provider: params.provider,
		prompt: params.prompt,
		maxTokens: params.maxTokens,
		timeoutMs: params.timeoutMs,
		profile: params.profile,
		preferredProfile: params.preferredProfile,
		authStore: params.authStore,
		agentDir: params.agentDir,
		cfg: params.cfg
	});
}
async function describeImageWithModelPayloadTransform(params, onPayload) {
	return await describeImagesWithModelPayloadTransform({
		images: [{
			buffer: params.buffer,
			fileName: params.fileName,
			mime: params.mime
		}],
		model: params.model,
		provider: params.provider,
		prompt: params.prompt,
		maxTokens: params.maxTokens,
		timeoutMs: params.timeoutMs,
		profile: params.profile,
		preferredProfile: params.preferredProfile,
		authStore: params.authStore,
		agentDir: params.agentDir,
		cfg: params.cfg
	}, onPayload);
}
//#endregion
export { describeImageWithModel, describeImageWithModelPayloadTransform, describeImagesWithModel, describeImagesWithModelPayloadTransform };
