import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { o as toAgentModelListLike } from "./model-input-ChW9XXsQ.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { u as resolveApiKeyForProvider } from "./model-auth-Db-JGIrg.js";
import { i as withProgressTotals } from "./progress-CE2g1zbv.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { i as formatTokenK, r as formatMs, u as updateConfig } from "./shared-CXerptPG.js";
import { t as loadModelsConfig } from "./load-config-B1XseUf7.js";
import { i as truncate, r as pad } from "./list.format-Bk2p2FnG.js";
import { t as inferParamBFromIdOrName } from "./model-param-b-Bj5BJb8S.js";
import { Type } from "typebox";
import { complete, getEnvApiKey, getModel } from "@earendil-works/pi-ai";
import { cancel, isCancel, multiselect } from "@clack/prompts";
//#region src/agents/model-scan.ts
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TIMEOUT_MS = 12e3;
const DEFAULT_CONCURRENCY = 3;
const BASE_IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";
const TOOL_PING = {
	name: "ping",
	description: "Return OK.",
	parameters: Type.Object({})
};
function normalizeCreatedAtMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value <= 0) return null;
	if (value > 0xe8d4a51000) return Math.round(value);
	return Math.round(value * 1e3);
}
function parseModality(modality) {
	if (!modality) return ["text"];
	return normalizeLowercaseStringOrEmpty(modality).split(/[^a-z]+/).filter(Boolean).includes("image") ? ["text", "image"] : ["text"];
}
function parseNumberString(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const num = Number(trimmed);
	if (!Number.isFinite(num)) return null;
	return num;
}
function parseOpenRouterPricing(value) {
	if (!value || typeof value !== "object") return null;
	const obj = value;
	const prompt = parseNumberString(obj.prompt);
	const completion = parseNumberString(obj.completion);
	const request = parseNumberString(obj.request) ?? 0;
	const image = parseNumberString(obj.image) ?? 0;
	const webSearch = parseNumberString(obj.web_search) ?? 0;
	const internalReasoning = parseNumberString(obj.internal_reasoning) ?? 0;
	if (prompt === null || completion === null) return null;
	return {
		prompt,
		completion,
		request,
		image,
		webSearch,
		internalReasoning
	};
}
function isFreeOpenRouterModel(entry) {
	if (entry.id.endsWith(":free")) return true;
	if (!entry.pricing) return false;
	return entry.pricing.prompt === 0 && entry.pricing.completion === 0;
}
async function withTimeout(timeoutMs, fn) {
	const controller = new AbortController();
	const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
async function fetchOpenRouterModels(fetchImpl, timeoutMs) {
	const res = await withTimeout(timeoutMs, (signal) => fetchImpl(OPENROUTER_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal
	}));
	if (!res.ok) throw new Error(`OpenRouter /models failed: HTTP ${res.status}`);
	const payload = await res.json();
	return (Array.isArray(payload.data) ? payload.data : []).map((entry) => {
		if (!entry || typeof entry !== "object") return null;
		const obj = entry;
		const id = normalizeOptionalString(obj.id) ?? "";
		if (!id) return null;
		const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;
		const contextLength = typeof obj.context_length === "number" && Number.isFinite(obj.context_length) ? obj.context_length : null;
		const maxCompletionTokens = typeof obj.max_completion_tokens === "number" && Number.isFinite(obj.max_completion_tokens) ? obj.max_completion_tokens : typeof obj.max_output_tokens === "number" && Number.isFinite(obj.max_output_tokens) ? obj.max_output_tokens : null;
		const supportedParameters = Array.isArray(obj.supported_parameters) ? obj.supported_parameters.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean) : [];
		return {
			id,
			name,
			contextLength,
			maxCompletionTokens,
			supportedParameters,
			supportedParametersCount: supportedParameters.length,
			supportsToolsMeta: supportedParameters.includes("tools"),
			modality: typeof obj.modality === "string" && obj.modality.trim() ? obj.modality.trim() : null,
			inferredParamB: inferParamBFromIdOrName(`${id} ${name}`),
			createdAtMs: normalizeCreatedAtMs(obj.created_at),
			pricing: parseOpenRouterPricing(obj.pricing)
		};
	}).filter((entry) => Boolean(entry));
}
async function probeTool(model, apiKey, timeoutMs) {
	const context = {
		messages: [{
			role: "user",
			content: "Call the ping tool with {} and nothing else.",
			timestamp: Date.now()
		}],
		tools: [TOOL_PING]
	};
	const startedAt = Date.now();
	try {
		if (!(await withTimeout(timeoutMs, (signal) => complete(model, context, {
			apiKey,
			maxTokens: 256,
			temperature: 0,
			toolChoice: "required",
			signal
		}))).content.some((block) => block.type === "toolCall")) return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: "No tool call returned"
		};
		return {
			ok: true,
			latencyMs: Date.now() - startedAt
		};
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: formatErrorMessage(err)
		};
	}
}
async function probeImage(model, apiKey, timeoutMs) {
	const context = { messages: [{
		role: "user",
		content: [{
			type: "text",
			text: "Reply with OK."
		}, {
			type: "image",
			data: BASE_IMAGE_PNG,
			mimeType: "image/png"
		}],
		timestamp: Date.now()
	}] };
	const startedAt = Date.now();
	try {
		await withTimeout(timeoutMs, (signal) => complete(model, context, {
			apiKey,
			maxTokens: 16,
			temperature: 0,
			signal
		}));
		return {
			ok: true,
			latencyMs: Date.now() - startedAt
		};
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: formatErrorMessage(err)
		};
	}
}
function ensureImageInput(model) {
	if (model.input?.includes("image")) return model;
	return {
		...model,
		input: Array.from(new Set([...model.input ?? [], "image"]))
	};
}
function buildOpenRouterScanResult(params) {
	const { entry, isFree } = params;
	return {
		id: entry.id,
		name: entry.name,
		provider: "openrouter",
		modelRef: `openrouter/${entry.id}`,
		contextLength: entry.contextLength,
		maxCompletionTokens: entry.maxCompletionTokens,
		supportedParametersCount: entry.supportedParametersCount,
		supportsToolsMeta: entry.supportsToolsMeta,
		modality: entry.modality,
		inferredParamB: entry.inferredParamB,
		createdAtMs: entry.createdAtMs,
		pricing: entry.pricing,
		isFree,
		tool: params.tool,
		image: params.image
	};
}
async function mapWithConcurrency(items, concurrency, fn, opts) {
	const limit = Math.max(1, Math.floor(concurrency));
	const results = Array.from({ length: items.length }, () => void 0);
	let nextIndex = 0;
	let completed = 0;
	const worker = async () => {
		while (true) {
			const current = nextIndex;
			nextIndex += 1;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
			completed += 1;
			opts?.onProgress?.(completed, items.length);
		}
	};
	if (items.length === 0) {
		opts?.onProgress?.(0, 0);
		return results;
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}
async function scanOpenRouterModels(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const probe = options.probe ?? true;
	const apiKey = options.apiKey?.trim() || getEnvApiKey("openrouter") || "";
	if (probe && !apiKey) throw new Error("Missing OpenRouter API key. Free OpenRouter models still require OPENROUTER_API_KEY for live probes and inference; call with probe:false to list public catalog metadata.");
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
	const minParamB = Math.max(0, Math.floor(options.minParamB ?? 0));
	const maxAgeDays = Math.max(0, Math.floor(options.maxAgeDays ?? 0));
	const providerFilter = normalizeProviderId(options.providerFilter ?? "");
	const catalog = await fetchOpenRouterModels(fetchImpl, timeoutMs);
	const now = Date.now();
	const filtered = catalog.filter((entry) => {
		if (!isFreeOpenRouterModel(entry)) return false;
		if (providerFilter) {
			if (normalizeProviderId(entry.id.split("/")[0] ?? "") !== providerFilter) return false;
		}
		if (minParamB > 0) {
			if ((entry.inferredParamB ?? 0) < minParamB) return false;
		}
		if (maxAgeDays > 0 && entry.createdAtMs) {
			if ((now - entry.createdAtMs) / (1440 * 60 * 1e3) > maxAgeDays) return false;
		}
		return true;
	});
	const baseModel = getModel("openrouter", "openrouter/auto");
	options.onProgress?.({
		phase: "probe",
		completed: 0,
		total: filtered.length
	});
	return mapWithConcurrency(filtered, concurrency, async (entry) => {
		const isFree = isFreeOpenRouterModel(entry);
		if (!probe) return buildOpenRouterScanResult({
			entry,
			isFree,
			tool: {
				ok: false,
				latencyMs: null,
				skipped: true
			},
			image: {
				ok: false,
				latencyMs: null,
				skipped: true
			}
		});
		const model = {
			...baseModel,
			id: entry.id,
			name: entry.name || entry.id,
			contextWindow: entry.contextLength ?? baseModel.contextWindow,
			maxTokens: entry.maxCompletionTokens ?? baseModel.maxTokens,
			input: parseModality(entry.modality),
			reasoning: baseModel.reasoning
		};
		return buildOpenRouterScanResult({
			entry,
			isFree,
			tool: await probeTool(model, apiKey, timeoutMs),
			image: model.input?.includes("image") ? await probeImage(ensureImageInput(model), apiKey, timeoutMs) : {
				ok: false,
				latencyMs: null,
				skipped: true
			}
		});
	}, { onProgress: (completed, total) => options.onProgress?.({
		phase: "probe",
		completed,
		total
	}) });
}
//#endregion
//#region src/commands/models/scan.ts
const MODEL_PAD = 42;
const CTX_PAD = 8;
const multiselect$1 = (params) => multiselect({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
});
function guardPromptCancel(value, runtime) {
	if (isCancel(value)) {
		cancel(stylePromptTitle("Model scan cancelled.") ?? "Model scan cancelled.");
		runtime.exit(0);
		throw new Error("unreachable");
	}
	return value;
}
function sortScanResults(results) {
	return results.slice().toSorted((a, b) => {
		const aImage = a.image.ok ? 1 : 0;
		const bImage = b.image.ok ? 1 : 0;
		if (aImage !== bImage) return bImage - aImage;
		const aToolLatency = a.tool.latencyMs ?? Number.POSITIVE_INFINITY;
		const bToolLatency = b.tool.latencyMs ?? Number.POSITIVE_INFINITY;
		if (aToolLatency !== bToolLatency) return aToolLatency - bToolLatency;
		return compareScanMetadata(a, b);
	});
}
function sortImageResults(results) {
	return results.slice().toSorted((a, b) => {
		const aLatency = a.image.latencyMs ?? Number.POSITIVE_INFINITY;
		const bLatency = b.image.latencyMs ?? Number.POSITIVE_INFINITY;
		if (aLatency !== bLatency) return aLatency - bLatency;
		return compareScanMetadata(a, b);
	});
}
function compareScanMetadata(a, b) {
	const aCtx = a.contextLength ?? 0;
	const bCtx = b.contextLength ?? 0;
	if (aCtx !== bCtx) return bCtx - aCtx;
	const aParams = a.inferredParamB ?? 0;
	const bParams = b.inferredParamB ?? 0;
	if (aParams !== bParams) return bParams - aParams;
	return a.modelRef.localeCompare(b.modelRef);
}
function buildScanHint(result) {
	return [
		result.tool.skipped ? "tool skip" : result.tool.ok ? `tool ${formatMs(result.tool.latencyMs)}` : "tool fail",
		result.image.skipped ? "img skip" : result.image.ok ? `img ${formatMs(result.image.latencyMs)}` : "img fail",
		result.contextLength ? `ctx ${formatTokenK(result.contextLength)}` : "ctx ?",
		result.inferredParamB ? `${result.inferredParamB}b` : null
	].filter(Boolean).join(" | ");
}
function printScanSummary(results, runtime) {
	const toolOk = results.filter((r) => r.tool.ok);
	const imageOk = results.filter((r) => r.image.ok);
	const toolImageOk = results.filter((r) => r.tool.ok && r.image.ok);
	const imageOnly = imageOk.filter((r) => !r.tool.ok);
	runtime.log(`Scan results: tested ${results.length}, tool ok ${toolOk.length}, image ok ${imageOk.length}, tool+image ok ${toolImageOk.length}, image only ${imageOnly.length}`);
}
function printMetadataOnlyNotice(params) {
	if (params.autoDowngraded) params.runtime.log("OpenRouter free models still require OPENROUTER_API_KEY for live probes and inference. Listing public catalog metadata only.");
	params.runtime.log(`Found ${params.results.length} OpenRouter free models (metadata only; configure OPENROUTER_API_KEY to test tools/images).`);
}
function printScanTable(results, runtime) {
	const header = [
		pad("Model", MODEL_PAD),
		pad("Tool", 10),
		pad("Image", 10),
		pad("Ctx", CTX_PAD),
		pad("Params", 8),
		"Notes"
	].join(" ");
	runtime.log(header);
	for (const entry of results) {
		const modelLabel = pad(truncate(entry.modelRef, MODEL_PAD), MODEL_PAD);
		const toolLabel = pad(entry.tool.skipped ? "skip" : entry.tool.ok ? formatMs(entry.tool.latencyMs) : "fail", 10);
		const imageLabel = pad(entry.image.ok ? formatMs(entry.image.latencyMs) : entry.image.skipped ? "skip" : "fail", 10);
		const ctxLabel = pad(formatTokenK(entry.contextLength), CTX_PAD);
		const paramsLabel = pad(entry.inferredParamB ? `${entry.inferredParamB}b` : "-", 8);
		const notes = entry.modality ? `modality:${entry.modality}` : "";
		runtime.log([
			modelLabel,
			toolLabel,
			imageLabel,
			ctxLabel,
			paramsLabel,
			notes
		].join(" "));
	}
}
async function modelsScanCommand(opts, runtime) {
	const minParams = opts.minParams ? Number(opts.minParams) : void 0;
	if (minParams !== void 0 && (!Number.isFinite(minParams) || minParams < 0)) throw new Error("--min-params must be >= 0");
	const maxAgeDays = opts.maxAgeDays ? Number(opts.maxAgeDays) : void 0;
	if (maxAgeDays !== void 0 && (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)) throw new Error("--max-age-days must be >= 0");
	const maxCandidates = opts.maxCandidates ? Number(opts.maxCandidates) : 6;
	if (!Number.isFinite(maxCandidates) || maxCandidates <= 0) throw new Error("--max-candidates must be > 0");
	const timeout = opts.timeout ? Number(opts.timeout) : void 0;
	if (timeout !== void 0 && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("--timeout must be > 0");
	const concurrency = opts.concurrency ? Number(opts.concurrency) : void 0;
	if (concurrency !== void 0 && (!Number.isFinite(concurrency) || concurrency <= 0)) throw new Error("--concurrency must be > 0");
	const requestedProbe = opts.probe ?? true;
	if (!requestedProbe && (opts.setDefault || opts.setImage)) throw new Error("Cannot apply metadata-only OpenRouter scan results. Remove --no-probe or configure OPENROUTER_API_KEY and rerun with probes before changing defaults.");
	let probe = requestedProbe;
	let storedKey;
	if (requestedProbe) {
		storedKey = getEnvApiKey("openrouter")?.trim() || void 0;
		if (!storedKey) try {
			storedKey = (await resolveApiKeyForProvider({
				provider: "openrouter",
				cfg: await loadModelsConfig({ commandName: "models scan" })
			})).apiKey?.trim() || void 0;
		} catch {
			storedKey = void 0;
		}
		if (!storedKey) {
			if (opts.setDefault || opts.setImage) throw new Error("Cannot apply metadata-only OpenRouter scan results. Configure OPENROUTER_API_KEY and rerun with probes before changing defaults.");
			probe = false;
		}
	}
	const results = await withProgressTotals({
		label: "Scanning OpenRouter models...",
		indeterminate: false,
		enabled: opts.json !== true
	}, async (update) => await scanOpenRouterModels({
		apiKey: storedKey ?? void 0,
		minParamB: minParams,
		maxAgeDays,
		providerFilter: opts.provider,
		timeoutMs: timeout,
		concurrency,
		probe,
		onProgress: ({ phase, completed, total }) => {
			if (phase !== "probe") return;
			update({
				completed,
				total,
				label: `${probe ? "Probing models" : "Scanning models"} (${completed}/${total})`
			});
		}
	}));
	if (!probe) {
		if (!opts.json) {
			printMetadataOnlyNotice({
				results,
				runtime,
				autoDowngraded: requestedProbe
			});
			printScanTable(sortScanResults(results), runtime);
		} else writeRuntimeJson(runtime, results);
		return;
	}
	const toolOk = results.filter((entry) => entry.tool.ok);
	if (toolOk.length === 0) throw new Error(`No tool-capable OpenRouter free models found. Try ${formatCliCommand("openclaw models scan --no-probe")} to inspect metadata-only candidates, or configure OPENROUTER_API_KEY before probing.`);
	const sorted = sortScanResults(results);
	const toolSorted = sortScanResults(toolOk);
	const imageSorted = sortImageResults(results.filter((entry) => entry.image.ok));
	const imagePreferred = toolSorted.filter((entry) => entry.image.ok);
	const preselected = (imagePreferred.length > 0 ? imagePreferred : toolSorted).slice(0, Math.floor(maxCandidates)).map((entry) => entry.modelRef);
	const imagePreselected = imageSorted.slice(0, Math.floor(maxCandidates)).map((entry) => entry.modelRef);
	if (!opts.json) {
		printScanSummary(results, runtime);
		printScanTable(sorted, runtime);
	}
	const noInput = opts.input === false;
	const canPrompt = process.stdin.isTTY && !opts.yes && !noInput && !opts.json;
	let selected = preselected;
	let selectedImages = imagePreselected;
	if (canPrompt) {
		selected = guardPromptCancel(await multiselect$1({
			message: "Select fallback models (ordered)",
			options: toolSorted.map((entry) => ({
				value: entry.modelRef,
				label: entry.modelRef,
				hint: buildScanHint(entry)
			})),
			initialValues: preselected
		}), runtime);
		if (imageSorted.length > 0) selectedImages = guardPromptCancel(await multiselect$1({
			message: "Select image fallback models (ordered)",
			options: imageSorted.map((entry) => ({
				value: entry.modelRef,
				label: entry.modelRef,
				hint: buildScanHint(entry)
			})),
			initialValues: imagePreselected
		}), runtime);
	} else if (!process.stdin.isTTY && !opts.yes && !noInput && !opts.json) throw new Error("Non-interactive scan: pass --yes to apply defaults.");
	if (selected.length === 0) throw new Error("No models selected for fallbacks.");
	if (opts.setImage && selectedImages.length === 0) throw new Error("No image-capable models selected for image model.");
	await updateConfig((cfg) => {
		const nextModels = { ...cfg.agents?.defaults?.models };
		for (const entry of selected) if (!nextModels[entry]) nextModels[entry] = {};
		for (const entry of selectedImages) if (!nextModels[entry]) nextModels[entry] = {};
		const existingImageModel = toAgentModelListLike(cfg.agents?.defaults?.imageModel);
		const nextImageModel = selectedImages.length > 0 ? {
			...existingImageModel?.primary ? { primary: existingImageModel.primary } : void 0,
			fallbacks: selectedImages,
			...opts.setImage ? { primary: selectedImages[0] } : {}
		} : cfg.agents?.defaults?.imageModel;
		const existingModel = toAgentModelListLike(cfg.agents?.defaults?.model);
		const defaults = {
			...cfg.agents?.defaults,
			model: {
				...existingModel?.primary ? { primary: existingModel.primary } : void 0,
				fallbacks: selected,
				...opts.setDefault ? { primary: selected[0] } : {}
			},
			...nextImageModel ? { imageModel: nextImageModel } : {},
			models: nextModels
		};
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults
			}
		};
	});
	if (opts.json) {
		writeRuntimeJson(runtime, {
			selected,
			selectedImages,
			setDefault: Boolean(opts.setDefault),
			setImage: Boolean(opts.setImage),
			results,
			warnings: []
		});
		return;
	}
	logConfigUpdated(runtime);
	runtime.log(`Fallbacks: ${selected.join(", ")}`);
	if (selectedImages.length > 0) runtime.log(`Image fallbacks: ${selectedImages.join(", ")}`);
	if (opts.setDefault) runtime.log(`Default model: ${selected[0]}`);
	if (opts.setImage && selectedImages.length > 0) runtime.log(`Image model: ${selectedImages[0]}`);
}
//#endregion
export { modelsScanCommand };
