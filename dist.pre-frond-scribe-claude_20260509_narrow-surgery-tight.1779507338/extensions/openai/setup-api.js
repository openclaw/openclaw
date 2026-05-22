import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { a as OPENAI_CHATGPT_DEVICE_PAIRING_LABEL, c as OPENAI_CODEX_API_KEY_BACKUP_HINT, d as OPENAI_CODEX_DEVICE_PAIRING_LABEL, f as OPENAI_CODEX_LOGIN_HINT, i as OPENAI_CHATGPT_DEVICE_PAIRING_HINT, l as OPENAI_CODEX_API_KEY_BACKUP_LABEL, m as OPENAI_CODEX_WIZARD_GROUP, n as OPENAI_API_KEY_LABEL, o as OPENAI_CHATGPT_LOGIN_HINT, p as OPENAI_CODEX_LOGIN_LABEL, s as OPENAI_CHATGPT_LOGIN_LABEL, t as OPENAI_ACCOUNT_WIZARD_GROUP, u as OPENAI_CODEX_DEVICE_PAIRING_HINT } from "../../auth-choice-copy-CI2uePXw.js";
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
		auth: [
			{
				id: "oauth",
				label: OPENAI_CHATGPT_LOGIN_LABEL,
				hint: OPENAI_CHATGPT_LOGIN_HINT,
				kind: "oauth",
				wizard: {
					choiceId: "openai",
					choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
					choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
					assistantPriority: -40,
					assistantVisibility: "manual-only",
					...OPENAI_ACCOUNT_WIZARD_GROUP
				},
				run: async (ctx) => runOpenAICodexProviderAuthMethod("oauth", ctx)
			},
			{
				id: "device-code",
				label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
				hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
				kind: "device_code",
				wizard: {
					choiceId: "openai-device-code",
					choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
					choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
					assistantPriority: -10,
					assistantVisibility: "manual-only",
					...OPENAI_ACCOUNT_WIZARD_GROUP
				},
				run: async (ctx) => runOpenAICodexProviderAuthMethod("device-code", ctx)
			},
			{
				id: "api-key",
				label: OPENAI_API_KEY_LABEL,
				hint: "Use your OpenAI API key directly",
				kind: "api_key",
				wizard: {
					choiceId: "openai-api-key",
					choiceLabel: OPENAI_API_KEY_LABEL,
					choiceHint: "Use your OpenAI API key directly",
					assistantPriority: 5,
					...OPENAI_ACCOUNT_WIZARD_GROUP
				},
				run: async (ctx) => runOpenAIProviderAuthMethod("api-key", ctx)
			}
		]
	};
}
function buildOpenAICodexSetupProvider() {
	return {
		id: "openai-codex",
		label: "OpenAI Codex",
		docsPath: "/providers/models",
		auth: [
			{
				id: "oauth",
				label: OPENAI_CODEX_LOGIN_LABEL,
				hint: OPENAI_CODEX_LOGIN_HINT,
				kind: "oauth",
				wizard: {
					choiceId: "openai-codex",
					choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
					choiceHint: OPENAI_CODEX_LOGIN_HINT,
					assistantPriority: -30,
					onboardingFeatured: true,
					...OPENAI_CODEX_WIZARD_GROUP
				},
				run: async (ctx) => runOpenAICodexProviderAuthMethod("oauth", ctx)
			},
			{
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
			},
			{
				id: "api-key",
				label: OPENAI_CODEX_API_KEY_BACKUP_LABEL,
				hint: OPENAI_CODEX_API_KEY_BACKUP_HINT,
				kind: "api_key",
				wizard: {
					choiceId: "openai-codex-api-key",
					choiceLabel: OPENAI_CODEX_API_KEY_BACKUP_LABEL,
					choiceHint: OPENAI_CODEX_API_KEY_BACKUP_HINT,
					assistantPriority: 5,
					assistantVisibility: "manual-only",
					...OPENAI_CODEX_WIZARD_GROUP
				},
				run: async (ctx) => runOpenAICodexProviderAuthMethod("api-key", ctx)
			}
		]
	};
}
var setup_api_default = definePluginEntry({
	id: "openai",
	name: "OpenAI Setup",
	description: "Lightweight OpenAI setup hooks",
	register(api) {
		api.registerProvider(buildOpenAISetupProvider());
		api.registerProvider(buildOpenAICodexSetupProvider());
	}
});
//#endregion
export { buildOpenAICodexSetupProvider, buildOpenAISetupProvider, setup_api_default as default };
