import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import "../../profiles-BC4VpDll.js";
import { t as applyOpencodeZenConfig } from "../../onboard-auth.config-opencode-CPtsorYE.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
//#region src/commands/opencode-zen-model-default.ts
const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
//#endregion
//#region extensions/opencode/index.ts
const PROVIDER_ID = "opencode";
const MINIMAX_PREFIX = "minimax-m2.5";
function isModernOpencodeModel(modelId) {
	const lower = modelId.trim().toLowerCase();
	if (lower.endsWith("-free") || lower === "alpha-glm-4.7") return false;
	return !lower.startsWith(MINIMAX_PREFIX);
}
const opencodePlugin = {
	id: PROVIDER_ID,
	name: "OpenCode Zen Provider",
	description: "Bundled OpenCode Zen provider plugin",
	configSchema: emptyPluginConfigSchema(),
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
				hint: "Shared API key for Zen + Go catalogs",
				optionKey: "opencodeZenApiKey",
				flagName: "--opencode-zen-api-key",
				envVar: "OPENCODE_API_KEY",
				promptMessage: "Enter OpenCode API key",
				profileIds: ["opencode:default", "opencode-go:default"],
				defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
				expectedProviders: ["opencode", "opencode-go"],
				applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
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
					groupId: "opencode",
					groupLabel: "OpenCode",
					groupHint: "Shared API key for Zen + Go catalogs"
				}
			})],
			capabilities: {
				openAiCompatTurnValidation: false,
				geminiThoughtSignatureSanitization: true,
				geminiThoughtSignatureModelHints: ["gemini"]
			},
			isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId)
		});
	}
};
//#endregion
export { opencodePlugin as default };
