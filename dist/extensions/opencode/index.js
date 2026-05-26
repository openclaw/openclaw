import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { c as resolveClaudeThinkingProfile, i as PASSTHROUGH_GEMINI_REPLAY_HOOKS, u as matchesExactOrPrefix } from "../../provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-E_5Yag4W.js";
import { t as OPENCODE_ZEN_DEFAULT_MODEL } from "../../provider-onboard-MLXAQX8H.js";
import "../../provider-auth-api-key-C06h8GOX.js";
import { n as applyOpencodeZenConfig } from "../../onboard-C-hUcL-z.js";
import "../../api-CahBs_F8.js";
import { t as opencodeMediaUnderstandingProvider } from "../../media-understanding-provider-Yppg8XoY.js";
//#region extensions/opencode/index.ts
const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"];
const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"];
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
const OPENCODE_SHARED_WIZARD_GROUP = {
	groupId: "opencode",
	groupLabel: "OpenCode",
	groupHint: OPENCODE_SHARED_HINT
};
function isModernOpencodeModel(modelId) {
	const lower = normalizeLowercaseStringOrEmpty(modelId);
	if (lower.endsWith("-free") || lower === "alpha-glm-4.7") return false;
	return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}
var opencode_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "OpenCode Zen Provider",
	description: "Bundled OpenCode Zen provider plugin",
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "OpenCode Zen",
			docsPath: "/providers/models",
			envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "OpenCode Zen catalog",
				hint: OPENCODE_SHARED_HINT,
				optionKey: "opencodeZenApiKey",
				flagName: "--opencode-zen-api-key",
				envVar: "OPENCODE_API_KEY",
				promptMessage: "Enter OpenCode API key",
				profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
				defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
				applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
				expectedProviders: ["opencode", "opencode-go"],
				noteMessage: [
					"OpenCode uses one API key across the Zen and Go catalogs.",
					"Zen provides access to Claude, GPT, Gemini, and more models.",
					"Get your API key at: https://opencode.ai/auth",
					"Choose the Zen catalog when you want the curated multi-model proxy."
				].join("\n"),
				noteTitle: "OpenCode",
				wizard: {
					choiceId: "opencode-zen",
					choiceLabel: "OpenCode Zen catalog",
					...OPENCODE_SHARED_WIZARD_GROUP
				}
			})],
			...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
			isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
			resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId)
		});
		api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
	}
});
//#endregion
export { opencode_default as default };
