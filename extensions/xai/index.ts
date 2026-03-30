import {
	coerceSecretRef,
	resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createToolStreamWrapper } from "openclaw/plugin-sdk/provider-stream";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
	applyXaiModelCompat,
	normalizeXaiModelId,
	resolveXaiModelCompatPatch,
	resolveXaiTransport,
	shouldContributeXaiCompat,
} from "./api.js";
import { createCodeExecutionTool } from "./code-execution.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXaiProvider } from "./provider-catalog.js";
import {
	isModernXaiModel,
	resolveXaiForwardCompatModel,
} from "./provider-models.js";
import {
	createXaiFastModeWrapper,
	createXaiToolCallArgumentDecodingWrapper,
	createXaiToolPayloadCompatibilityWrapper,
} from "./stream.js";
import { createXaiWebSearchProvider } from "./web-search.js";
import { createXSearchTool } from "./x-search.js";

const PROVIDER_ID = "xai";

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
	const literal = normalizeSecretInputString(value);
	if (literal) {
		return literal;
	}
	const ref = coerceSecretRef(value);
	return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readLegacyGrokFallback(
	config: Record<string, unknown>,
): { apiKey: string; source: string } | undefined {
	const tools = config.tools;
	if (!tools || typeof tools !== "object") {
		return undefined;
	}
	const web = (tools as Record<string, unknown>).web;
	if (!web || typeof web !== "object") {
		return undefined;
	}
	const search = (web as Record<string, unknown>).search;
	if (!search || typeof search !== "object") {
		return undefined;
	}
	const grok = (search as Record<string, unknown>).grok;
	if (!grok || typeof grok !== "object") {
		return undefined;
	}
	const apiKey = readConfiguredOrManagedApiKey(
		(grok as Record<string, unknown>).apiKey,
	);
	return apiKey
		? { apiKey, source: "tools.web.search.grok.apiKey" }
		: undefined;
}

function resolveXaiProviderFallbackAuth(
	config: unknown,
): { apiKey: string; source: string } | undefined {
	if (!config || typeof config !== "object") {
		return undefined;
	}
	const record = config as Record<string, unknown>;
	const pluginApiKey = readConfiguredOrManagedApiKey(
		resolveProviderWebSearchPluginConfig(record, PROVIDER_ID)?.apiKey,
	);
	if (pluginApiKey) {
		return {
			apiKey: pluginApiKey,
			source: "plugins.entries.xai.config.webSearch.apiKey",
		};
	}
	return readLegacyGrokFallback(record);
}

export default defineSingleProviderPluginEntry({
	id: "xai",
	name: "xAI Plugin",
	description: "Bundled xAI plugin",
	provider: {
		label: "xAI",
		aliases: ["x-ai"],
		docsPath: "/providers/xai",
		auth: [
			{
				methodId: "api-key",
				label: "xAI API key",
				hint: "API key",
				optionKey: "xaiApiKey",
				flagName: "--xai-api-key",
				envVar: "XAI_API_KEY",
				promptMessage: "Enter xAI API key",
				defaultModel: XAI_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyXaiConfig(cfg),
				wizard: {
					groupLabel: "xAI (Grok)",
				},
			},
		],
		catalog: {
			buildProvider: buildXaiProvider,
		},
		prepareExtraParams: (ctx) => {
			if (ctx.extraParams?.tool_stream !== undefined) {
				return ctx.extraParams;
			}
			return {
				...ctx.extraParams,
				tool_stream: true,
			};
		},
		wrapStreamFn: (ctx) => {
			let streamFn = createXaiToolPayloadCompatibilityWrapper(ctx.streamFn);
			if (typeof ctx.extraParams?.fastMode === "boolean") {
				streamFn = createXaiFastModeWrapper(streamFn, ctx.extraParams.fastMode);
			}
			streamFn = createXaiToolCallArgumentDecodingWrapper(streamFn);
			return createToolStreamWrapper(
				streamFn,
				ctx.extraParams?.tool_stream !== false,
			);
		},
		// Provider-specific fallback auth stays owned by the xAI plugin so core
		// auth/discovery code can consume it generically without parsing xAI's
		// private config layout. Callers may receive a real key from the active
		// runtime snapshot or a non-secret SecretRef marker from source config.
		resolveSyntheticAuth: ({ config }) => {
			const fallbackAuth = resolveXaiProviderFallbackAuth(config);
			if (!fallbackAuth) {
				return undefined;
			}
			return {
				apiKey: fallbackAuth.apiKey,
				source: fallbackAuth.source,
				mode: "api-key" as const,
			};
		},
		normalizeResolvedModel: ({ model }) => applyXaiModelCompat(model),
		normalizeTransport: ({ provider, api, baseUrl }) =>
			resolveXaiTransport({ provider, api, baseUrl }),
		contributeResolvedModelCompat: ({ modelId, model }) =>
			shouldContributeXaiCompat({ modelId, model })
				? resolveXaiModelCompatPatch()
				: undefined,
		normalizeModelId: ({ modelId }) => normalizeXaiModelId(modelId),
		resolveDynamicModel: (ctx) =>
			resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
		isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
	},
	register(api) {
		api.registerWebSearchProvider(createXaiWebSearchProvider());
		api.registerTool(
			(ctx) =>
				createCodeExecutionTool({
					config: ctx.config,
					runtimeConfig: ctx.runtimeConfig,
				}),
			{ name: "code_execution" },
		);
		api.registerTool(
			(ctx) =>
				createXSearchTool({
					config: ctx.config,
					runtimeConfig: ctx.runtimeConfig,
				}),
			{ name: "x_search" },
		);
	},
});
