import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMistralModelCompat, MISTRAL_MODEL_COMPAT_PATCH } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMistralProvider } from "./provider-catalog.js";

const PROVIDER_ID = "mistral";
const MISTRAL_MODEL_HINTS = [
	"mistral",
	"mistralai",
	"mixtral",
	"codestral",
	"pixtral",
	"devstral",
	"ministral",
] as const;

function isMistralBaseUrl(baseUrl: unknown): boolean {
	if (typeof baseUrl !== "string" || !baseUrl.trim()) {
		return false;
	}
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api.mistral.ai";
	} catch {
		return baseUrl.toLowerCase().includes("api.mistral.ai");
	}
}

function isMistralModelHint(modelId: string): boolean {
	const normalized = modelId.trim().toLowerCase();
	return MISTRAL_MODEL_HINTS.some(
		(hint) =>
			normalized === hint ||
			normalized.startsWith(`${hint}/`) ||
			normalized.startsWith(`${hint}-`) ||
			normalized.startsWith(`${hint}:`),
	);
}

function shouldContributeMistralCompat(params: {
	modelId: string;
	model: { api?: unknown; baseUrl?: unknown };
}): boolean {
	if (params.model.api !== "openai-completions") {
		return false;
	}
	return (
		isMistralBaseUrl(params.model.baseUrl) || isMistralModelHint(params.modelId)
	);
}

export default defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "Mistral Provider",
	description: "Bundled Mistral provider plugin",
	provider: {
		label: "Mistral",
		docsPath: "/providers/models",
		auth: [
			{
				methodId: "api-key",
				label: "Mistral API key",
				hint: "API key",
				optionKey: "mistralApiKey",
				flagName: "--mistral-api-key",
				envVar: "MISTRAL_API_KEY",
				promptMessage: "Enter Mistral API key",
				defaultModel: MISTRAL_DEFAULT_MODEL_REF,
				applyConfig: (cfg) => applyMistralConfig(cfg),
				wizard: {
					groupLabel: "Mistral AI",
				},
			},
		],
		catalog: {
			buildProvider: buildMistralProvider,
			allowExplicitBaseUrl: true,
		},
		normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
		contributeResolvedModelCompat: ({ modelId, model }) =>
			shouldContributeMistralCompat({ modelId, model })
				? MISTRAL_MODEL_COMPAT_PATCH
				: undefined,
		capabilities: {
			transcriptToolCallIdMode: "strict9",
			transcriptToolCallIdModelHints: [
				"mistral",
				"mixtral",
				"codestral",
				"pixtral",
				"devstral",
				"ministral",
				"mistralai",
			],
		},
	},
	register(api) {
		api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
	},
});
