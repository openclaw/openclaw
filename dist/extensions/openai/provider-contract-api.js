import { d as OPENAI_CODEX_DEVICE_PAIRING_LABEL, f as OPENAI_CODEX_LOGIN_HINT, m as OPENAI_CODEX_WIZARD_GROUP, n as OPENAI_API_KEY_LABEL, p as OPENAI_CODEX_LOGIN_LABEL, t as OPENAI_ACCOUNT_WIZARD_GROUP, u as OPENAI_CODEX_DEVICE_PAIRING_HINT } from "../../auth-choice-copy-CI2uePXw.js";
//#region extensions/openai/provider-contract-api.ts
const noopAuth = async () => ({ profiles: [] });
function createOpenAICodexProvider() {
	return {
		id: "openai-codex",
		label: "OpenAI Codex",
		docsPath: "/providers/models",
		oauthProfileIdRepairs: [{
			legacyProfileId: "openai-codex:default",
			promptLabel: "OpenAI Codex"
		}],
		auth: [{
			id: "oauth",
			kind: "oauth",
			label: OPENAI_CODEX_LOGIN_LABEL,
			hint: OPENAI_CODEX_LOGIN_HINT,
			run: noopAuth,
			wizard: {
				choiceId: "openai-codex",
				choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
				choiceHint: OPENAI_CODEX_LOGIN_HINT,
				assistantPriority: -30,
				onboardingFeatured: true,
				...OPENAI_CODEX_WIZARD_GROUP
			}
		}, {
			id: "device-code",
			kind: "device_code",
			label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
			hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
			run: noopAuth,
			wizard: {
				choiceId: "openai-codex-device-code",
				choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
				choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
				assistantPriority: -10,
				...OPENAI_CODEX_WIZARD_GROUP
			}
		}]
	};
}
function createOpenAIProvider() {
	return {
		id: "openai",
		label: "OpenAI",
		hookAliases: ["azure-openai", "azure-openai-responses"],
		docsPath: "/providers/models",
		envVars: ["OPENAI_API_KEY"],
		auth: [{
			id: "api-key",
			kind: "api_key",
			label: OPENAI_API_KEY_LABEL,
			hint: "Use your OpenAI API key directly",
			run: noopAuth,
			wizard: {
				choiceId: "openai-api-key",
				choiceLabel: OPENAI_API_KEY_LABEL,
				choiceHint: "Use your OpenAI API key directly",
				assistantPriority: 5,
				...OPENAI_ACCOUNT_WIZARD_GROUP
			}
		}]
	};
}
//#endregion
export { createOpenAICodexProvider, createOpenAIProvider };
