import { t as definePluginEntry } from "../../plugin-entry-CEeEexhG.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-CCrWwWPa.js";
import { a as OPENAI_CODEX_LOGIN_HINT, i as OPENAI_CODEX_DEVICE_PAIRING_LABEL, n as OPENAI_API_KEY_WIZARD_GROUP, o as OPENAI_CODEX_LOGIN_LABEL, r as OPENAI_CODEX_DEVICE_PAIRING_HINT, s as OPENAI_CODEX_WIZARD_GROUP, t as OPENAI_API_KEY_LABEL } from "../../auth-choice-copy-PqCMQPq8.js";
//#region extensions/openai/setup-api.ts
async function runOpenAIProviderAuthMethod(methodId, ctx) {
	const { buildOpenAIProvider } = await import("./openai-provider.js");
	const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
	if (!method) return { profiles: [] };
	return method.run(ctx);
}
async function runOpenAICodexProviderAuthMethod(methodId, ctx) {
	const { buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js");
	const method = buildOpenAICodexProviderPlugin().auth.find((entry) => entry.id === methodId);
	if (!method) return { profiles: [] };
	return method.run(ctx);
}
function buildOpenAISetupProvider() {
	return {
		id: "openai",
		label: "OpenAI",
		docsPath: "/providers/models",
		envVars: ["OPENAI_API_KEY"],
		auth: [{
			id: "api-key",
			label: OPENAI_API_KEY_LABEL,
			hint: "Use your OpenAI API key directly",
			kind: "api_key",
			wizard: {
				choiceId: "openai-api-key",
				choiceLabel: OPENAI_API_KEY_LABEL,
				...OPENAI_API_KEY_WIZARD_GROUP
			},
			run: async (ctx) => runOpenAIProviderAuthMethod("api-key", ctx)
		}]
	};
}
function buildOpenAICodexSetupProvider() {
	return {
		id: "openai-codex",
		label: "OpenAI Codex",
		docsPath: "/providers/models",
		auth: [{
			id: "oauth",
			label: OPENAI_CODEX_LOGIN_LABEL,
			hint: OPENAI_CODEX_LOGIN_HINT,
			kind: "oauth",
			wizard: {
				choiceId: "openai-codex",
				choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
				choiceHint: OPENAI_CODEX_LOGIN_HINT,
				assistantPriority: -30,
				...OPENAI_CODEX_WIZARD_GROUP
			},
			run: async (ctx) => runOpenAICodexProviderAuthMethod("oauth", ctx)
		}, {
			id: "device-code",
			label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
			hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
			kind: "device_code",
			wizard: {
				choiceId: "openai-codex-device-code",
				choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
				choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
				assistantPriority: -10,
				...OPENAI_CODEX_WIZARD_GROUP
			},
			run: async (ctx) => runOpenAICodexProviderAuthMethod("device-code", ctx)
		}]
	};
}
var setup_api_default = definePluginEntry({
	id: "openai",
	name: "OpenAI Setup",
	description: "Lightweight OpenAI setup hooks",
	register(api) {
		api.registerProvider(buildOpenAISetupProvider());
		api.registerProvider(buildOpenAICodexSetupProvider());
		api.registerCliBackend(buildOpenAICodexCliBackend());
	}
});
//#endregion
export { setup_api_default as default };
