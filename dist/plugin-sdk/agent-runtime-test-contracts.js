import { r as resolveProviderIdForAuth } from "../provider-auth-aliases-4jqi6Djx.js";
import { a as resetGlobalHookRunner, i as initializeGlobalHookRunner } from "../hook-runner-global-BkXXy1ub.js";
import { F as createEmptyPluginRegistry, x as setActivePluginRegistry, y as resetPluginRuntimeStateForTest } from "../runtime-DHxRl5F1.js";
import { n as resetAdjustedParamsByToolCallIdForTests } from "../pi-tools.before-tool-call.state-B92-KsPf.js";
import { n as createMockPluginRegistry } from "../hooks.test-helpers-C0hHeapp.js";
import { vi } from "vitest";
//#region src/plugin-sdk/test-helpers/agents/auth-profile-runtime-contract.ts
const AUTH_PROFILE_RUNTIME_CONTRACT = {
	sessionId: "session-auth-contract",
	sessionKey: "agent:main:auth-contract",
	runId: "run-auth-contract",
	workspacePrompt: "continue with the bound Codex profile",
	openAiProvider: "openai",
	openAiCodexProvider: "openai-codex",
	codexCliProvider: "codex-cli",
	codexHarnessProvider: "codex",
	claudeCliProvider: "claude-cli",
	openAiProfileId: "openai:work",
	openAiCodexProfileId: "openai-codex:work",
	anthropicProfileId: "anthropic:work"
};
function createAuthAliasManifestRegistry() {
	return {
		plugins: [{
			id: "openai",
			origin: "bundled",
			channels: [],
			providers: [],
			cliBackends: [],
			skills: [],
			hooks: [],
			rootDir: "/tmp/openclaw-auth-contract-plugin",
			source: "test",
			manifestPath: "/tmp/openclaw-auth-contract-plugin/plugin.json",
			providerAuthChoices: [{
				provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
				method: "oauth",
				choiceId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
				deprecatedChoiceIds: [AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider]
			}]
		}],
		diagnostics: []
	};
}
function expectedForwardedAuthProfile(params) {
	return resolveProviderIdForAuth(params.provider, params.aliasLookupParams) === resolveProviderIdForAuth(params.authProfileProvider, params.aliasLookupParams) ? params.sessionAuthProfileId : void 0;
}
//#endregion
//#region src/plugin-sdk/test-helpers/agents/delivery-no-reply-runtime-contract.ts
const DELIVERY_NO_REPLY_RUNTIME_CONTRACT = {
	sessionId: "session-delivery-contract",
	sessionKey: "agent:main:delivery-contract",
	runId: "run-delivery-contract",
	prompt: "deliver the follow-up contract turn",
	originChannel: "discord",
	originTo: "channel:C1",
	dispatcherText: "visible dispatcher fallback",
	visibleText: "visible follow-up",
	silentText: "NO_REPLY",
	jsonSilentText: "{\"action\":\"NO_REPLY\"}"
};
//#endregion
//#region src/plugin-sdk/test-helpers/agents/openclaw-owned-tool-runtime-contract.ts
function textToolResult(text, details = {}) {
	return {
		content: [{
			type: "text",
			text
		}],
		details
	};
}
function mediaToolResult(text, mediaUrl, audioAsVoice = false) {
	return textToolResult(text, { media: {
		mediaUrl,
		...audioAsVoice ? { audioAsVoice } : {}
	} });
}
function installOpenClawOwnedToolHooks(params) {
	const beforeToolCall = vi.fn(async () => {
		if (params?.blockReason) return {
			block: true,
			blockReason: params.blockReason
		};
		return params?.adjustedParams ? { params: params.adjustedParams } : {};
	});
	const afterToolCall = vi.fn(async () => {});
	initializeGlobalHookRunner(createMockPluginRegistry([{
		hookName: "before_tool_call",
		handler: beforeToolCall
	}, {
		hookName: "after_tool_call",
		handler: afterToolCall
	}]));
	return {
		beforeToolCall,
		afterToolCall
	};
}
/**
* Installs only the Codex app-server `tool_result` middleware fixture.
* Pair with `installOpenClawOwnedToolHooks()` when a test asserts before/after hook behavior.
*/
function installCodexToolResultMiddleware(handler) {
	const middleware = vi.fn(async (event) => ({ result: handler(event) }));
	const registry = createEmptyPluginRegistry();
	const factory = async (codex) => {
		codex.on("tool_result", middleware);
	};
	registry.codexAppServerExtensionFactories.push({
		pluginId: "runtime-contract",
		pluginName: "Runtime Contract",
		rawFactory: factory,
		factory,
		source: "test"
	});
	setActivePluginRegistry(registry);
	return { middleware };
}
function resetOpenClawOwnedToolHooks() {
	resetGlobalHookRunner();
	resetPluginRuntimeStateForTest();
	resetAdjustedParamsByToolCallIdForTests();
}
//#endregion
//#region src/plugin-sdk/test-helpers/agents/outcome-fallback-runtime-contract.ts
const OUTCOME_FALLBACK_RUNTIME_CONTRACT = {
	primaryProvider: "openai-codex",
	primaryModel: "gpt-5.4",
	fallbackProvider: "anthropic",
	fallbackModel: "claude-haiku-3-5",
	sessionId: "session-outcome-contract",
	sessionKey: "agent:main:outcome-contract",
	runId: "run-outcome-contract",
	prompt: "finish the contract turn",
	reasoningOnlyText: "I need to reason about this before answering.",
	planningOnlyText: "Inspect state, then decide the next step."
};
function createContractRunResult(overrides = {}) {
	const { meta, ...rest } = overrides;
	return {
		payloads: [],
		didSendViaMessagingTool: false,
		messagingToolSentTexts: [],
		messagingToolSentMediaUrls: [],
		messagingToolSentTargets: [],
		successfulCronAdds: 0,
		...rest,
		meta: {
			durationMs: 1,
			...meta
		}
	};
}
function createContractFallbackConfig() {
	return { agents: { defaults: { model: {
		primary: `${OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel}`,
		fallbacks: [`${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel}`]
	} } } };
}
//#endregion
//#region src/plugin-sdk/test-helpers/agents/prompt-overlay-runtime-contract.ts
const GPT5_CONTRACT_MODEL_ID = "gpt-5.4";
const GPT5_PREFIXED_CONTRACT_MODEL_ID = "openai/gpt-5.4";
const NON_GPT5_CONTRACT_MODEL_ID = "gpt-4.1";
const OPENAI_CONTRACT_PROVIDER_ID = "openai";
const OPENAI_CODEX_CONTRACT_PROVIDER_ID = "openai-codex";
const CODEX_CONTRACT_PROVIDER_ID = "codex";
const NON_OPENAI_CONTRACT_PROVIDER_ID = "openrouter";
function openAiPluginPersonalityConfig(personality) {
	return { plugins: { entries: { openai: { config: { personality } } } } };
}
function sharedGpt5PersonalityConfig(personality) {
	return { agents: { defaults: { promptOverlays: { gpt5: { personality } } } } };
}
function codexPromptOverlayContext(params) {
	return {
		provider: CODEX_CONTRACT_PROVIDER_ID,
		modelId: params?.modelId ?? "gpt-5.4",
		promptMode: "full",
		agentDir: "/tmp/openclaw-codex-prompt-contract-agent",
		workspaceDir: "/tmp/openclaw-codex-prompt-contract-workspace",
		...params?.config ? { config: params.config } : {}
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/agents/schema-normalization-runtime-contract.ts
function createParameterFreeTool(name = "ping") {
	return {
		name,
		description: "Parameter-free test tool",
		parameters: {}
	};
}
function createStrictCompatibleTool(name = "lookup") {
	return {
		name,
		description: "Strict-compatible test tool",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false
		}
	};
}
function createPermissiveTool(name = "schedule") {
	return {
		name,
		description: "Permissive test tool",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string" },
				cron: { type: "string" }
			},
			required: ["action"],
			additionalProperties: true
		}
	};
}
function createNativeOpenAIResponsesModel() {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: 2e5,
		maxTokens: 8192
	};
}
function createNativeOpenAICodexResponsesModel() {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: 2e5,
		maxTokens: 8192
	};
}
function createProxyOpenAIResponsesModel() {
	return {
		id: "custom-gpt",
		name: "Custom GPT",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: 2e5,
		maxTokens: 8192
	};
}
function normalizedParameterFreeSchema() {
	return {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: false
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/agents/transcript-repair-runtime-contract.ts
const QUEUED_USER_MESSAGE_MARKER = "[Queued user message that arrived while the previous turn was still active]";
function textOrphanLeaf(text = "older active-turn message") {
	return { content: text };
}
function structuredOrphanLeaf() {
	return { content: [
		{
			type: "text",
			text: "please inspect this"
		},
		{
			type: "image_url",
			image_url: { url: "https://example.test/cat.png" }
		},
		{
			type: "input_audio",
			audio_url: "https://example.test/cat.wav"
		}
	] };
}
function inlineDataUriOrphanLeaf() {
	return { content: [{
		type: "text",
		text: "please inspect this inline image"
	}, {
		type: "image_url",
		image_url: { url: `data:image/png;base64,${"a".repeat(4096)}` }
	}] };
}
function mediaOnlyHistoryMessage() {
	return {
		role: "user",
		content: [{
			type: "image",
			data: "b".repeat(2048),
			mimeType: "image/png"
		}],
		timestamp: 1
	};
}
function structuredHistoryMessage() {
	return {
		role: "user",
		content: [{
			type: "text",
			text: "older structured context"
		}, {
			type: "image",
			data: "c".repeat(64),
			mimeType: "image/png"
		}],
		timestamp: 1
	};
}
function currentPromptHistoryMessage(prompt) {
	return {
		role: "user",
		content: [{
			type: "text",
			text: prompt
		}],
		timestamp: 2
	};
}
function assistantHistoryMessage(text = "ack") {
	return {
		role: "assistant",
		content: [{
			type: "text",
			text
		}],
		timestamp: 2
	};
}
//#endregion
export { AUTH_PROFILE_RUNTIME_CONTRACT, CODEX_CONTRACT_PROVIDER_ID, DELIVERY_NO_REPLY_RUNTIME_CONTRACT, GPT5_CONTRACT_MODEL_ID, GPT5_PREFIXED_CONTRACT_MODEL_ID, NON_GPT5_CONTRACT_MODEL_ID, NON_OPENAI_CONTRACT_PROVIDER_ID, OPENAI_CODEX_CONTRACT_PROVIDER_ID, OPENAI_CONTRACT_PROVIDER_ID, OUTCOME_FALLBACK_RUNTIME_CONTRACT, QUEUED_USER_MESSAGE_MARKER, assistantHistoryMessage, codexPromptOverlayContext, createAuthAliasManifestRegistry, createContractFallbackConfig, createContractRunResult, createNativeOpenAICodexResponsesModel, createNativeOpenAIResponsesModel, createParameterFreeTool, createPermissiveTool, createProxyOpenAIResponsesModel, createStrictCompatibleTool, currentPromptHistoryMessage, expectedForwardedAuthProfile, inlineDataUriOrphanLeaf, installCodexToolResultMiddleware, installOpenClawOwnedToolHooks, mediaOnlyHistoryMessage, mediaToolResult, normalizedParameterFreeSchema, openAiPluginPersonalityConfig, resetOpenClawOwnedToolHooks, sharedGpt5PersonalityConfig, structuredHistoryMessage, structuredOrphanLeaf, textOrphanLeaf, textToolResult };
