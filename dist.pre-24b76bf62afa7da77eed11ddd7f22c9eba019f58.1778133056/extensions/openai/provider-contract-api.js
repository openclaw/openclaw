import { a as OPENAI_CODEX_LOGIN_HINT, i as OPENAI_CODEX_DEVICE_PAIRING_LABEL, n as OPENAI_API_KEY_WIZARD_GROUP, o as OPENAI_CODEX_LOGIN_LABEL, r as OPENAI_CODEX_DEVICE_PAIRING_HINT, s as OPENAI_CODEX_WIZARD_GROUP, t as OPENAI_API_KEY_LABEL } from "../../auth-choice-copy-DqJhDS9U.js";
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
				assistantPriority: -40,
				...OPENAI_API_KEY_WIZARD_GROUP
			}
		}]
	};
}
//#endregion
export { createOpenAICodexProvider, createOpenAIProvider };
