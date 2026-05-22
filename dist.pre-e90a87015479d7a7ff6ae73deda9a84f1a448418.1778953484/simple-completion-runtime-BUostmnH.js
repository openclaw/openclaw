import { i as formatErrorMessage } from "./errors-C5Jbj3g5.js";
import { a as resolveAgentDir } from "./agent-scope-config-D57hqxoj.js";
import { n as resolveAgentEffectiveModelPrimary } from "./agent-scope-cOcI3Bf3.js";
import "./defaults-BngqyJjG.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-Cl6MrvvR.js";
import { b as resolveModelRefFromString, i as buildModelAliasIndex } from "./model-selection-shared-DvIdVzM0.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-CtlJEyaP.js";
import { a as prepareProviderRuntimeAuth } from "./provider-runtime.runtime.js";
import { n as applyLocalNoAuthHeaderOverride, r as getApiKeyForModel } from "./model-auth-ChezQtKQ.js";
import { n as resolveModelAsync, t as resolveModel } from "./model-BRsLuZKK.js";
import { t as prepareModelForSimpleCompletion } from "./simple-completion-transport-Ca9_lQmD.js";
import { completeSimple } from "@earendil-works/pi-ai";
//#region src/agents/simple-completion-runtime.ts
function resolveSimpleCompletionSelectionForAgent(params) {
	const fallbackRef = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const modelRef = params.modelRef?.trim() || resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
	const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: fallbackRef.provider || "openai"
	});
	const resolved = split ? resolveModelRefFromString({
		raw: split.model,
		defaultProvider: fallbackRef.provider || "openai",
		aliasIndex
	}) : null;
	const provider = resolved?.ref.provider ?? fallbackRef.provider;
	const modelId = resolved?.ref.model ?? fallbackRef.model;
	if (!provider || !modelId) return null;
	return {
		provider,
		modelId,
		profileId: split?.profile || void 0,
		agentDir: resolveAgentDir(params.cfg, params.agentId)
	};
}
async function setRuntimeApiKeyForCompletion(params) {
	if (params.model.provider === "github-copilot") {
		const { resolveCopilotApiToken } = await import("./github-copilot-token-CeOWix27.js");
		const copilotToken = await resolveCopilotApiToken({ githubToken: params.apiKey });
		params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
		return {
			apiKey: copilotToken.token,
			baseUrl: copilotToken.baseUrl
		};
	}
	const preparedAuth = await prepareProviderRuntimeAuth({
		provider: params.model.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: process.env,
		context: {
			config: params.cfg,
			workspaceDir: params.workspaceDir,
			env: process.env,
			provider: params.model.provider,
			modelId: params.model.id,
			model: params.model,
			apiKey: params.apiKey,
			authMode: params.authMode,
			profileId: params.profileId
		}
	});
	const runtimeApiKey = preparedAuth?.apiKey?.trim() || params.apiKey;
	params.authStorage.setRuntimeApiKey(params.model.provider, runtimeApiKey);
	return {
		apiKey: runtimeApiKey,
		baseUrl: preparedAuth?.baseUrl
	};
}
function hasMissingApiKeyAllowance(params) {
	return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}
async function prepareSimpleCompletionModel(params) {
	const resolved = params.skipPiDiscovery ? await resolveModelAsync(params.provider, params.modelId, params.agentDir, params.cfg, {
		...params.allowBundledStaticCatalogFallback !== void 0 ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback } : {},
		skipPiDiscovery: true
	}) : resolveModel(params.provider, params.modelId, params.agentDir, params.cfg);
	if (!resolved.model) return { error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}` };
	let auth;
	try {
		auth = await getApiKeyForModel({
			model: resolved.model,
			cfg: params.cfg,
			agentDir: params.agentDir,
			profileId: params.profileId,
			preferredProfile: params.preferredProfile
		});
	} catch (err) {
		return { error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(err)}` };
	}
	const rawApiKey = auth.apiKey?.trim();
	if (!rawApiKey && !hasMissingApiKeyAllowance({
		mode: auth.mode,
		allowMissingApiKeyModes: params.allowMissingApiKeyModes
	})) return {
		error: `No API key resolved for provider "${resolved.model.provider}" (auth mode: ${auth.mode}).`,
		auth
	};
	let resolvedApiKey = rawApiKey;
	let resolvedModel = resolved.model;
	if (rawApiKey) {
		const runtimeCredential = await setRuntimeApiKeyForCompletion({
			authStorage: resolved.authStorage,
			model: resolved.model,
			apiKey: rawApiKey,
			authMode: auth.mode,
			cfg: params.cfg,
			workspaceDir: params.agentDir,
			profileId: auth.profileId
		});
		resolvedApiKey = runtimeCredential.apiKey;
		const runtimeBaseUrl = runtimeCredential.baseUrl?.trim();
		if (runtimeBaseUrl) resolvedModel = {
			...resolvedModel,
			baseUrl: runtimeBaseUrl
		};
	}
	const resolvedAuth = {
		...auth,
		apiKey: resolvedApiKey
	};
	return {
		model: applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
		auth: resolvedAuth
	};
}
async function prepareSimpleCompletionModelForAgent(params) {
	const selection = resolveSimpleCompletionSelectionForAgent({
		cfg: params.cfg,
		agentId: params.agentId,
		modelRef: params.modelRef
	});
	if (!selection) return { error: `No model configured for agent ${params.agentId}.` };
	const prepared = await prepareSimpleCompletionModel({
		cfg: params.cfg,
		provider: selection.provider,
		modelId: selection.modelId,
		agentDir: selection.agentDir,
		profileId: selection.profileId,
		preferredProfile: params.preferredProfile,
		allowMissingApiKeyModes: params.allowMissingApiKeyModes,
		...params.allowBundledStaticCatalogFallback !== void 0 ? { allowBundledStaticCatalogFallback: params.allowBundledStaticCatalogFallback } : {},
		skipPiDiscovery: params.skipPiDiscovery
	});
	if ("error" in prepared) return {
		...prepared,
		selection
	};
	return {
		selection,
		model: prepared.model,
		auth: prepared.auth
	};
}
async function completeWithPreparedSimpleCompletionModel(params) {
	const completionModel = prepareModelForSimpleCompletion({
		model: params.model,
		cfg: params.cfg
	});
	const { reasoning: rawReasoning, ...options } = params.options ?? {};
	const reasoning = normalizeSimpleCompletionReasoning(rawReasoning);
	return await completeSimple(completionModel, params.context, {
		...options,
		...reasoning ? { reasoning } : {},
		apiKey: params.auth.apiKey
	});
}
function normalizeSimpleCompletionReasoning(reasoning) {
	switch (reasoning) {
		case void 0:
		case "off": return;
		case "adaptive": return "medium";
		case "max": return "xhigh";
		default: return reasoning;
	}
}
//#endregion
export { resolveSimpleCompletionSelectionForAgent as i, prepareSimpleCompletionModel as n, prepareSimpleCompletionModelForAgent as r, completeWithPreparedSimpleCompletionModel as t };
