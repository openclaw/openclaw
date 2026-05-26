import { n as resolveCopilotTransportApi, r as resolveStaticCopilotModelOverride, t as resolveCopilotModelCompat } from "../../model-metadata-CuGtXx9C.js";
//#region extensions/github-copilot/models-defaults.ts
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MODEL_IDS = [
	"claude-haiku-4.5",
	"claude-opus-4.5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-sonnet-4",
	"claude-sonnet-4.6",
	"claude-sonnet-4.5",
	"gemini-2.5-pro",
	"gemini-3-flash",
	"gemini-3.1-pro",
	"gpt-4.1",
	"gpt-5-mini",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"grok-code-fast-1",
	"raptor-mini",
	"goldeneye"
];
function getDefaultCopilotModelIds() {
	return [...DEFAULT_MODEL_IDS];
}
function buildCopilotModelDefinition(modelId) {
	const id = modelId.trim();
	if (!id) throw new Error("Model id required");
	const staticOverride = resolveStaticCopilotModelOverride(id);
	const compat = staticOverride?.compat ?? resolveCopilotModelCompat(id);
	return {
		id,
		name: staticOverride?.name ?? id,
		api: staticOverride?.api ?? resolveCopilotTransportApi(id),
		reasoning: staticOverride?.reasoning ?? false,
		input: staticOverride?.input ?? ["text", "image"],
		cost: staticOverride?.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: staticOverride?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: staticOverride?.maxTokens ?? DEFAULT_MAX_TOKENS,
		...compat ? { compat } : {}
	};
}
//#endregion
export { buildCopilotModelDefinition, getDefaultCopilotModelIds };
