import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as createSubsystemLogger } from "./subsystem-DtPhzVBn.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import "./core-C5MRjAwL.js";
import "./error-runtime-7Da26TEA.js";
import { t as refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh-B6pOEsEL.js";
import { n as resolveBedrockConfigApiKey } from "./discovery-shared-DoBq6HVk.js";
//#region extensions/amazon-bedrock/discovery.ts
const log = createSubsystemLogger("bedrock-discovery");
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32e3;
const DEFAULT_MAX_TOKENS = 4096;
/**
* Bedrock's ListFoundationModels and GetFoundationModel APIs return no token
* limit information — only model ID, name, modalities, and lifecycle status.
* There is currently no Bedrock API to discover context windows or max output
* tokens programmatically.
*
* This map provides correct context window values for known models so that
* session management, compaction thresholds, and context overflow detection
* work correctly. If AWS adds token metadata to the API in the future, this
* table should become a fallback rather than the primary source.
*
* Inference profile prefixes (us., eu., ap., global.) are stripped before lookup.
*
* Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
*          https://platform.claude.com/docs/en/about-claude/models
*/
const KNOWN_CONTEXT_WINDOWS = {
	"anthropic.claude-3-7-sonnet-20250219-v1:0": 2e5,
	"anthropic.claude-opus-4-7": 1e6,
	"anthropic.claude-opus-4-6-v1": 1e6,
	"anthropic.claude-opus-4-6-v1:0": 1e6,
	"anthropic.claude-sonnet-4-6": 1e6,
	"anthropic.claude-sonnet-4-6-v1:0": 1e6,
	"anthropic.claude-sonnet-4-5-20250929-v1:0": 2e5,
	"anthropic.claude-sonnet-4-20250514-v1:0": 2e5,
	"anthropic.claude-opus-4-5-20251101-v1:0": 2e5,
	"anthropic.claude-opus-4-1-20250805-v1:0": 2e5,
	"anthropic.claude-haiku-4-5-20251001-v1:0": 2e5,
	"anthropic.claude-3-5-haiku-20241022-v1:0": 2e5,
	"anthropic.claude-3-haiku-20240307-v1:0": 2e5,
	"amazon.nova-premier-v1:0": 1e6,
	"amazon.nova-pro-v1:0": 3e5,
	"amazon.nova-lite-v1:0": 3e5,
	"amazon.nova-micro-v1:0": 128e3,
	"amazon.nova-2-lite-v1:0": 3e5,
	"minimax.minimax-m2.5": 1e6,
	"minimax.minimax-m2.1": 1e6,
	"minimax.minimax-m2": 1e6,
	"meta.llama4-maverick-17b-instruct-v1:0": 1e6,
	"meta.llama4-scout-17b-instruct-v1:0": 512e3,
	"meta.llama3-3-70b-instruct-v1:0": 128e3,
	"meta.llama3-2-90b-instruct-v1:0": 128e3,
	"meta.llama3-2-11b-instruct-v1:0": 128e3,
	"meta.llama3-2-3b-instruct-v1:0": 128e3,
	"meta.llama3-2-1b-instruct-v1:0": 128e3,
	"meta.llama3-1-405b-instruct-v1:0": 128e3,
	"meta.llama3-1-70b-instruct-v1:0": 128e3,
	"meta.llama3-1-8b-instruct-v1:0": 128e3,
	"nvidia.nemotron-super-3-120b": 256e3,
	"nvidia.nemotron-nano-3-30b": 128e3,
	"nvidia.nemotron-nano-12b-v2": 128e3,
	"nvidia.nemotron-nano-9b-v2": 128e3,
	"mistral.mistral-large-3-675b-instruct": 128e3,
	"mistral.mistral-large-2407-v1:0": 128e3,
	"mistral.mistral-small-2402-v1:0": 32e3,
	"deepseek.r1-v1:0": 128e3,
	"deepseek.v3.2": 128e3,
	"cohere.command-r-plus-v1:0": 128e3,
	"cohere.command-r-v1:0": 128e3,
	"ai21.jamba-1-5-large-v1:0": 256e3,
	"ai21.jamba-1-5-mini-v1:0": 256e3,
	"google.gemma-3-27b-it": 128e3,
	"google.gemma-3-12b-it": 128e3,
	"google.gemma-3-4b-it": 128e3,
	"zai.glm-5": 128e3,
	"zai.glm-4.7": 128e3,
	"zai.glm-4.7-flash": 128e3,
	"qwen.qwen3-coder-next": 256e3,
	"qwen.qwen3-coder-30b-a3b-v1:0": 256e3,
	"qwen.qwen3-32b-v1:0": 128e3,
	"qwen.qwen3-vl-235b-a22b": 128e3
};
/**
* Resolve the real context window for a Bedrock model ID.
* Strips inference profile prefixes (us., eu., ap., global.) before lookup.
*/
function resolveKnownContextWindow(modelId) {
	const candidates = [modelId, modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "")];
	for (const candidate of candidates) {
		if (KNOWN_CONTEXT_WINDOWS[candidate] !== void 0) return KNOWN_CONTEXT_WINDOWS[candidate];
		const withoutVersionSuffix = candidate.replace(/:0$/, "");
		if (withoutVersionSuffix !== candidate && KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix] !== void 0) return KNOWN_CONTEXT_WINDOWS[withoutVersionSuffix];
	}
}
const DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
async function loadBedrockDiscoverySdk() {
	const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import("@aws-sdk/client-bedrock");
	return {
		createClient: (region) => new BedrockClient({ region }),
		createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
		createListInferenceProfilesCommand: (input) => new ListInferenceProfilesCommand(input)
	};
}
function createInjectedClientDiscoverySdk() {
	class ListFoundationModelsCommand {
		constructor(input = {}) {
			this.input = input;
		}
	}
	class ListInferenceProfilesCommand {
		constructor(input = {}) {
			this.input = input;
		}
	}
	return {
		createClient() {
			throw new Error("clientFactory is required for injected Bedrock discovery commands");
		},
		createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
		createListInferenceProfilesCommand: (input) => new ListInferenceProfilesCommand(input)
	};
}
const discoveryCache = /* @__PURE__ */ new Map();
let hasLoggedBedrockError = false;
function normalizeProviderFilter(filter) {
	if (!filter || filter.length === 0) return [];
	const normalized = new Set(filter.map((entry) => normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry)));
	return Array.from(normalized).toSorted();
}
function buildCacheKey(params) {
	return JSON.stringify(params);
}
function includesTextModalities(modalities) {
	return (modalities ?? []).some((entry) => normalizeOptionalLowercaseString(entry) === "text");
}
function isActive(summary) {
	const status = summary.modelLifecycle?.status;
	return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}
function mapInputModalities(summary) {
	const inputs = summary.inputModalities ?? [];
	const mapped = /* @__PURE__ */ new Set();
	for (const modality of inputs) {
		const lower = normalizeOptionalLowercaseString(modality);
		if (lower === "text") mapped.add("text");
		if (lower === "image") mapped.add("image");
	}
	if (mapped.size === 0) mapped.add("text");
	return Array.from(mapped);
}
function inferReasoningSupport(summary) {
	const haystack = normalizeLowercaseStringOrEmpty(`${summary.modelId ?? ""} ${summary.modelName ?? ""}`);
	return haystack.includes("reasoning") || haystack.includes("thinking");
}
function resolveDefaultContextWindow(config) {
	const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
	return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}
function resolveDefaultMaxTokens(config) {
	const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
	return value > 0 ? value : DEFAULT_MAX_TOKENS;
}
function matchesProviderFilter(summary, filter) {
	if (filter.length === 0) return true;
	const normalized = normalizeOptionalLowercaseString(summary.providerName ?? (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : void 0));
	if (!normalized) return false;
	return filter.includes(normalized);
}
function shouldIncludeSummary(summary, filter) {
	if (!summary.modelId?.trim()) return false;
	if (!matchesProviderFilter(summary, filter)) return false;
	if (summary.responseStreamingSupported !== true) return false;
	if (!includesTextModalities(summary.outputModalities)) return false;
	if (!isActive(summary)) return false;
	return true;
}
function toModelDefinition(summary, defaults) {
	const id = summary.modelId?.trim() ?? "";
	return {
		id,
		name: summary.modelName?.trim() || id,
		reasoning: inferReasoningSupport(summary),
		input: mapInputModalities(summary),
		cost: DEFAULT_COST,
		contextWindow: resolveKnownContextWindow(id) ?? defaults.contextWindow,
		maxTokens: defaults.maxTokens
	};
}
/**
* Resolve the base foundation model ID from an inference profile.
*
* System-defined profiles use a region prefix:
*   "us.anthropic.claude-sonnet-4-6" → "anthropic.claude-sonnet-4-6"
*
* Application profiles carry the model ARN in their models[] array:
*   models[0].modelArn = "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6"
*   → "anthropic.claude-sonnet-4-6"
*/
function resolveBaseModelId(profile) {
	const firstArn = profile.models?.[0]?.modelArn;
	if (firstArn) {
		const arnMatch = /foundation-model\/(.+)$/.exec(firstArn);
		if (arnMatch) return arnMatch[1];
	}
	if (profile.type === "SYSTEM_DEFINED") {
		const id = profile.inferenceProfileId ?? "";
		const prefixMatch = /^(?:us|eu|ap|apac|au|jp|global)\.(.+)$/i.exec(id);
		if (prefixMatch) return prefixMatch[1];
	}
}
/**
* Fetch raw inference profile summaries from the Bedrock control plane.
* Handles pagination. Best-effort: silently returns empty array if IAM lacks
* bedrock:ListInferenceProfiles permission.
*/
async function fetchInferenceProfileSummaries(client, createListInferenceProfilesCommand) {
	try {
		const profiles = [];
		let nextToken;
		do {
			const response = await client.send(createListInferenceProfilesCommand({ nextToken }));
			for (const summary of response.inferenceProfileSummaries ?? []) profiles.push(summary);
			nextToken = response.nextToken;
		} while (nextToken);
		return profiles;
	} catch (error) {
		log.debug?.("Skipping inference profile discovery", { error: formatErrorMessage(error) });
		return [];
	}
}
/**
* Convert raw inference profile summaries into model definitions.
*
* Each profile inherits capabilities (modalities, reasoning, context window,
* cost) from its underlying foundation model. This ensures that
* "us.anthropic.claude-sonnet-4-6" has the same capabilities as
* "anthropic.claude-sonnet-4-6" — including image input, reasoning support,
* and token limits.
*
* When the foundation model isn't found in the map (e.g. the model is only
* available via inference profiles in this region), safe defaults are used.
*/
function resolveInferenceProfiles(profiles, defaults, providerFilter, foundationModels) {
	const discovered = [];
	for (const profile of profiles) {
		if (!profile.inferenceProfileId?.trim()) continue;
		if (profile.status !== "ACTIVE") continue;
		if (providerFilter.length > 0) {
			if (!(profile.models ?? []).some((m) => {
				const provider = m.modelArn?.split("/")?.[1]?.split(".")?.[0];
				return provider ? providerFilter.includes(normalizeOptionalLowercaseString(provider) ?? "") : false;
			})) continue;
		}
		const baseModelId = resolveBaseModelId(profile);
		const baseModel = baseModelId ? foundationModels.get(normalizeLowercaseStringOrEmpty(baseModelId)) : void 0;
		discovered.push({
			id: profile.inferenceProfileId,
			name: profile.inferenceProfileName?.trim() || profile.inferenceProfileId,
			reasoning: baseModel?.reasoning ?? false,
			input: baseModel?.input ?? ["text"],
			cost: baseModel?.cost ?? DEFAULT_COST,
			contextWindow: baseModel?.contextWindow ?? resolveKnownContextWindow(baseModelId ?? profile.inferenceProfileId ?? "") ?? defaults.contextWindow,
			maxTokens: baseModel?.maxTokens ?? defaults.maxTokens
		});
	}
	return discovered;
}
function resetBedrockDiscoveryCacheForTest() {
	discoveryCache.clear();
	hasLoggedBedrockError = false;
}
async function discoverBedrockModels(params) {
	const refreshIntervalSeconds = Math.max(0, Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS));
	const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
	const defaultContextWindow = resolveDefaultContextWindow(params.config);
	const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
	const cacheKey = buildCacheKey({
		region: params.region,
		providerFilter,
		refreshIntervalSeconds,
		defaultContextWindow,
		defaultMaxTokens
	});
	const now = params.now?.() ?? Date.now();
	if (refreshIntervalSeconds > 0) {
		const cached = discoveryCache.get(cacheKey);
		if (cached?.value && cached.expiresAt > now) return cached.value;
		if (cached?.inFlight) return cached.inFlight;
	}
	const sdk = params.clientFactory ? createInjectedClientDiscoverySdk() : await loadBedrockDiscoverySdk();
	const clientFactory = params.clientFactory ?? ((region) => sdk.createClient(region));
	if (!params.clientFactory) await refreshAwsSharedConfigCacheForBedrock();
	const client = clientFactory(params.region);
	const discoveryPromise = (async () => {
		const [rawFoundationResponse, profileSummaries] = await Promise.all([client.send(sdk.createListFoundationModelsCommand()), fetchInferenceProfileSummaries(client, (input) => sdk.createListInferenceProfilesCommand(input))]);
		const foundationResponse = rawFoundationResponse;
		const discovered = [];
		const seenIds = /* @__PURE__ */ new Set();
		const foundationModels = /* @__PURE__ */ new Map();
		for (const summary of foundationResponse.modelSummaries ?? []) {
			if (!shouldIncludeSummary(summary, providerFilter)) continue;
			const def = toModelDefinition(summary, {
				contextWindow: defaultContextWindow,
				maxTokens: defaultMaxTokens
			});
			discovered.push(def);
			const normalizedId = normalizeLowercaseStringOrEmpty(def.id);
			seenIds.add(normalizedId);
			foundationModels.set(normalizedId, def);
		}
		const inferenceProfiles = resolveInferenceProfiles(profileSummaries, {
			contextWindow: defaultContextWindow,
			maxTokens: defaultMaxTokens
		}, providerFilter, foundationModels);
		for (const profile of inferenceProfiles) {
			const normalizedId = normalizeLowercaseStringOrEmpty(profile.id);
			if (!seenIds.has(normalizedId)) {
				discovered.push(profile);
				seenIds.add(normalizedId);
			}
		}
		return discovered.toSorted((a, b) => {
			const aGlobal = a.id.startsWith("global.") ? 0 : 1;
			const bGlobal = b.id.startsWith("global.") ? 0 : 1;
			if (aGlobal !== bGlobal) return aGlobal - bGlobal;
			return a.name.localeCompare(b.name);
		});
	})();
	if (refreshIntervalSeconds > 0) discoveryCache.set(cacheKey, {
		expiresAt: now + refreshIntervalSeconds * 1e3,
		inFlight: discoveryPromise
	});
	try {
		const value = await discoveryPromise;
		if (refreshIntervalSeconds > 0) discoveryCache.set(cacheKey, {
			expiresAt: now + refreshIntervalSeconds * 1e3,
			value
		});
		return value;
	} catch (error) {
		if (refreshIntervalSeconds > 0) discoveryCache.delete(cacheKey);
		if (!hasLoggedBedrockError) {
			hasLoggedBedrockError = true;
			log.warn("Failed to discover Bedrock models", { error: formatErrorMessage(error) });
		}
		return [];
	}
}
async function resolveImplicitBedrockProvider(params) {
	const env = params.env ?? process.env;
	const discoveryConfig = {
		...params.config?.models?.bedrockDiscovery,
		...params.pluginConfig?.discovery
	};
	const enabled = discoveryConfig?.enabled;
	const hasAwsCreds = resolveBedrockConfigApiKey(env) !== void 0;
	if (enabled === false) return null;
	if (enabled !== true && !hasAwsCreds) return null;
	const region = discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
	const models = await discoverBedrockModels({
		region,
		config: discoveryConfig,
		clientFactory: params.clientFactory
	});
	if (models.length === 0) return null;
	return {
		baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
		api: "bedrock-converse-stream",
		auth: "aws-sdk",
		models
	};
}
//#endregion
export { resetBedrockDiscoveryCacheForTest as n, resolveImplicitBedrockProvider as r, discoverBedrockModels as t };
