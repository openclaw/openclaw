import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { n as createLazyPromiseLoader } from "./lazy-promise-SFT4i6yI.js";
import { y as truncateUtf16Safe } from "./utils-CKsuXgDI.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { a as resolvePluginControlPlaneFingerprint } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { $ as resolveProviderRuntimePlugin, p as inspectProviderToolSchemasWithPlugin, v as normalizeProviderToolSchemasWithPlugin } from "./provider-runtime-DXB7r8u2.js";
import "./model-selection-VRXWv5rs.js";
import { u as isGoogleModelApi } from "./pi-embedded-helpers-CVGWGeIq.js";
import { t as log$1 } from "./logger-8oA4pYXO.js";
import { b as shouldPreserveThinkingBlocks } from "./provider-model-shared-D-slKnZa.js";
//#region src/agents/model-tool-support.ts
function supportsModelTools(model) {
	return (model.compat && typeof model.compat === "object" ? model.compat : void 0)?.supportsTools !== false;
}
//#endregion
//#region src/agents/content-blocks.ts
function collectTextContentBlocks(content) {
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
	}
	return parts;
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-schema-runtime.ts
function buildProviderToolSchemaContext(params, provider) {
	return {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model,
		tools: params.tools
	};
}
/**
* Runs provider-owned tool-schema normalization without encoding provider
* families in the embedded runner.
*/
function normalizeProviderToolSchemas(params) {
	const provider = params.provider.trim();
	const pluginNormalized = normalizeProviderToolSchemasWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		runtimeHandle: params.runtimeHandle,
		context: buildProviderToolSchemaContext(params, provider)
	});
	return Array.isArray(pluginNormalized) ? pluginNormalized : params.tools;
}
/**
* Logs provider-owned tool-schema diagnostics after normalization.
*/
function logProviderToolSchemaDiagnostics(params) {
	const provider = params.provider.trim();
	const diagnostics = inspectProviderToolSchemasWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		runtimeHandle: params.runtimeHandle,
		context: buildProviderToolSchemaContext(params, provider)
	});
	if (!Array.isArray(diagnostics)) return;
	if (diagnostics.length === 0) return;
	const summary = summarizeProviderToolSchemaDiagnostics(diagnostics);
	log$1.warn(`provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`, {
		provider: params.provider,
		toolCount: params.tools.length,
		diagnosticCount: diagnostics.length,
		tools: params.tools.map((tool, index) => `${index}:${tool.name}`),
		diagnostics: diagnostics.map((diagnostic) => ({
			index: diagnostic.toolIndex,
			tool: diagnostic.toolName,
			violations: diagnostic.violations.slice(0, 12),
			violationCount: diagnostic.violations.length
		}))
	});
}
function summarizeProviderToolSchemaDiagnostics(diagnostics) {
	const visible = diagnostics.slice(0, 6).map((diagnostic) => {
		const violationCount = diagnostic.violations.length;
		return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
	});
	const remaining = diagnostics.length - visible.length;
	return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
//#endregion
//#region src/agents/transcript-policy.ts
function shouldAllowProviderOwnedThinkingReplay(params) {
	return isAnthropicApi(params.modelApi) && params.policy.validateAnthropicTurns && params.policy.preserveSignatures && !params.policy.dropThinkingBlocks;
}
const DEFAULT_TRANSCRIPT_POLICY = {
	sanitizeMode: "images-only",
	sanitizeToolCallIds: false,
	toolCallIdMode: void 0,
	preserveNativeAnthropicToolUseIds: false,
	repairToolUseResultPairing: true,
	preserveSignatures: false,
	sanitizeThoughtSignatures: void 0,
	sanitizeThinkingSignatures: false,
	dropThinkingBlocks: false,
	dropReasoningFromHistory: false,
	applyGoogleTurnOrdering: false,
	validateGeminiTurns: false,
	validateAnthropicTurns: false,
	allowSyntheticToolResults: false
};
function isAnthropicApi(modelApi) {
	return modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream";
}
function isOpenAiResponsesCompatibleApi(modelApi) {
	return modelApi === "openai-responses" || modelApi === "openai-codex-responses" || modelApi === "azure-openai-responses";
}
function isClaudeFamilyModelId(modelId) {
	const id = normalizeLowercaseStringOrEmpty(modelId);
	return /(?:^|[./:_-])claude(?:$|[./:_-])/.test(id);
}
function modelDisablesReasoningEffort(model) {
	return (model?.compat)?.supportsReasoningEffort === false;
}
/**
* Provides a narrow replay-policy fallback for providers that do not have an
* owning runtime plugin.
*
* This exists to preserve generic custom-provider behavior. Bundled providers
* should express replay ownership through `buildReplayPolicy` instead.
*/
function buildUnownedProviderTransportReplayFallback(params) {
	const isGoogle = isGoogleModelApi(params.modelApi);
	const isAnthropic = isAnthropicApi(params.modelApi);
	const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
	const requiresOpenAiCompatibleToolIdSanitization = params.modelApi === "openai-completions" || params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses" || params.modelApi === "azure-openai-responses";
	if (!isGoogle && !isAnthropic && !isStrictOpenAiCompatible && !requiresOpenAiCompatibleToolIdSanitization) return;
	const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
	const isClaudeOpenAiResponses = isOpenAiResponsesCompatibleApi(params.modelApi) ? isClaudeFamilyModelId(modelId) : false;
	return {
		...isGoogle || isAnthropic ? { sanitizeMode: "full" } : {},
		...isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : {},
		...isAnthropic ? { preserveSignatures: true } : {},
		...isGoogle ? { sanitizeThoughtSignatures: {
			allowBase64Only: true,
			includeCamelCase: true
		} } : {},
		...isAnthropic && modelId.includes("claude") ? { dropThinkingBlocks: !shouldPreserveThinkingBlocks(modelId) } : {},
		...isAnthropic && modelDisablesReasoningEffort(params.model) ? { dropThinkingBlocks: true } : {},
		...isStrictOpenAiCompatible ? { dropReasoningFromHistory: true } : {},
		...isGoogle || isStrictOpenAiCompatible ? { applyAssistantFirstOrderingFix: true } : {},
		...isGoogle || isStrictOpenAiCompatible ? { validateGeminiTurns: true } : {},
		...isAnthropic || isStrictOpenAiCompatible || isClaudeOpenAiResponses ? { validateAnthropicTurns: true } : {},
		...isGoogle || isAnthropic || isOpenAiResponsesCompatibleApi(params.modelApi) ? { allowSyntheticToolResults: true } : {}
	};
}
function mergeTranscriptPolicy(policy, basePolicy = DEFAULT_TRANSCRIPT_POLICY) {
	if (!policy) return basePolicy;
	return {
		...basePolicy,
		...policy.sanitizeMode != null ? { sanitizeMode: policy.sanitizeMode } : {},
		...typeof policy.sanitizeToolCallIds === "boolean" ? { sanitizeToolCallIds: policy.sanitizeToolCallIds } : {},
		...policy.toolCallIdMode ? { toolCallIdMode: policy.toolCallIdMode } : {},
		...typeof policy.preserveNativeAnthropicToolUseIds === "boolean" ? { preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds } : {},
		...typeof policy.repairToolUseResultPairing === "boolean" ? { repairToolUseResultPairing: policy.repairToolUseResultPairing } : {},
		...typeof policy.preserveSignatures === "boolean" ? { preserveSignatures: policy.preserveSignatures } : {},
		...policy.sanitizeThoughtSignatures ? { sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures } : {},
		...typeof policy.dropThinkingBlocks === "boolean" ? { dropThinkingBlocks: policy.dropThinkingBlocks } : {},
		...typeof policy.dropReasoningFromHistory === "boolean" ? { dropReasoningFromHistory: policy.dropReasoningFromHistory } : {},
		...typeof policy.applyAssistantFirstOrderingFix === "boolean" ? { applyGoogleTurnOrdering: policy.applyAssistantFirstOrderingFix } : {},
		...typeof policy.validateGeminiTurns === "boolean" ? { validateGeminiTurns: policy.validateGeminiTurns } : {},
		...typeof policy.validateAnthropicTurns === "boolean" ? { validateAnthropicTurns: policy.validateAnthropicTurns } : {},
		...typeof policy.allowSyntheticToolResults === "boolean" ? { allowSyntheticToolResults: policy.allowSyntheticToolResults } : {}
	};
}
const transcriptPolicyCache = /* @__PURE__ */ new WeakMap();
function canCacheTranscriptPolicy(params) {
	if (!params.config) return false;
	return !params.env || params.env === process.env;
}
function resolveTranscriptPolicyCacheKey(params) {
	return JSON.stringify({
		provider: params.provider,
		modelApi: params.modelApi ?? "",
		modelId: params.modelId ?? "",
		dropsThinkingForReasoningCompat: modelDisablesReasoningEffort(params.model),
		workspaceDir: params.workspaceDir ?? "",
		pluginControlPlane: resolvePluginControlPlaneFingerprint({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env
		})
	});
}
function resolveTranscriptPolicy(params) {
	const provider = normalizeProviderId(params.provider ?? "");
	const cacheConfig = canCacheTranscriptPolicy(params) ? params.config : void 0;
	const cacheKey = cacheConfig ? resolveTranscriptPolicyCacheKey({
		...params,
		provider,
		config: cacheConfig
	}) : void 0;
	if (cacheConfig && cacheKey) {
		const cached = transcriptPolicyCache.get(cacheConfig)?.get(cacheKey);
		if (cached) return cached;
	}
	const runtimePlugin = params.runtimeHandle?.plugin ?? (provider ? resolveProviderRuntimePlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) : void 0);
	const context = {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider,
		modelId: params.modelId ?? "",
		modelApi: params.modelApi,
		model: params.model
	};
	const buildReplayPolicy = runtimePlugin?.buildReplayPolicy;
	const policy = buildReplayPolicy ? mergeTranscriptPolicy(buildReplayPolicy(context) ?? void 0) : mergeTranscriptPolicy(buildUnownedProviderTransportReplayFallback({
		modelApi: params.modelApi,
		modelId: params.modelId,
		model: params.model
	}));
	if (cacheConfig && cacheKey) {
		let configCache = transcriptPolicyCache.get(cacheConfig);
		if (!configCache) {
			configCache = /* @__PURE__ */ new Map();
			transcriptPolicyCache.set(cacheConfig, configCache);
		}
		configCache.set(cacheKey, policy);
	}
	return policy;
}
//#endregion
//#region src/agents/harness/tool-result-middleware.ts
const log = createSubsystemLogger("agents/harness");
const MAX_MIDDLEWARE_CONTENT_BLOCKS = 200;
const MAX_MIDDLEWARE_TEXT_CHARS = 1e5;
const MAX_MIDDLEWARE_IMAGE_DATA_CHARS = 5e6;
const MAX_MIDDLEWARE_DETAILS_BYTES = 1e5;
const MAX_MIDDLEWARE_DETAILS_DEPTH = 20;
const MAX_MIDDLEWARE_DETAILS_KEYS = 1e3;
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isValidMiddlewareContentBlock(value) {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string" && value.text.length <= MAX_MIDDLEWARE_TEXT_CHARS;
	if (value.type === "image") return typeof value.mimeType === "string" && value.mimeType.trim().length > 0 && typeof value.data === "string" && value.data.length <= MAX_MIDDLEWARE_IMAGE_DATA_CHARS;
	return false;
}
function isValidMiddlewareDetails(value, state = {
	keys: 0,
	bytes: 0,
	seen: /* @__PURE__ */ new WeakSet()
}, depth = 0) {
	if (value === void 0 || value === null) return true;
	if (depth > MAX_MIDDLEWARE_DETAILS_DEPTH) return false;
	if (typeof value === "string") {
		state.bytes += value.length;
		return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		state.bytes += String(value).length;
		return state.bytes <= MAX_MIDDLEWARE_DETAILS_BYTES;
	}
	if (typeof value !== "object") return false;
	if (state.seen.has(value)) return false;
	state.seen.add(value);
	if (Array.isArray(value)) {
		state.keys += value.length;
		if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS) return false;
		for (const entry of value) if (!isValidMiddlewareDetails(entry, state, depth + 1)) return false;
		return true;
	}
	for (const [key, entry] of Object.entries(value)) {
		state.keys += 1;
		state.bytes += key.length;
		if (state.keys > MAX_MIDDLEWARE_DETAILS_KEYS || state.bytes > MAX_MIDDLEWARE_DETAILS_BYTES) return false;
		if (!isValidMiddlewareDetails(entry, state, depth + 1)) return false;
	}
	return true;
}
function isValidMiddlewareToolResult(value) {
	if (!isRecord(value) || !Array.isArray(value.content)) return false;
	if (value.content.length > MAX_MIDDLEWARE_CONTENT_BLOCKS) return false;
	return value.content.every(isValidMiddlewareContentBlock) && isValidMiddlewareDetails(value.details);
}
function buildMiddlewareFailureResult() {
	return {
		content: [{
			type: "text",
			text: "Tool output unavailable due to post-processing error."
		}],
		details: {
			status: "error",
			middlewareError: true
		}
	};
}
function createAgentToolResultMiddlewareRunner(ctx, handlers) {
	const middlewareContext = {
		...ctx,
		harness: ctx.harness ?? ctx.runtime
	};
	let resolvedHandlers = handlers;
	const resolvedHandlersLoader = createLazyPromiseLoader(async () => {
		const { loadAgentToolResultMiddlewaresForRuntime } = await import("./agent-tool-result-middleware-loader-Cal8O2Qc.js");
		return loadAgentToolResultMiddlewaresForRuntime({ runtime: ctx.runtime });
	});
	const resolveHandlers = async () => {
		if (resolvedHandlers) return resolvedHandlers;
		resolvedHandlers = await resolvedHandlersLoader.load();
		return resolvedHandlers;
	};
	return { async applyToolResultMiddleware(event) {
		let current = event.result;
		for (const handler of await resolveHandlers()) try {
			const candidate = (await handler({
				...event,
				result: current
			}, middlewareContext))?.result ?? current;
			if (isValidMiddlewareToolResult(candidate)) current = candidate;
			else {
				log.warn(`[${ctx.runtime}] discarded invalid tool result middleware output for ${truncateUtf16Safe(event.toolName, 120)}`);
				return buildMiddlewareFailureResult();
			}
		} catch {
			log.warn(`[${ctx.runtime}] tool result middleware failed for ${truncateUtf16Safe(event.toolName, 120)}`);
			return buildMiddlewareFailureResult();
		}
		return current;
	} };
}
//#endregion
export { normalizeProviderToolSchemas as a, logProviderToolSchemaDiagnostics as i, resolveTranscriptPolicy as n, collectTextContentBlocks as o, shouldAllowProviderOwnedThinkingReplay as r, supportsModelTools as s, createAgentToolResultMiddlewareRunner as t };
