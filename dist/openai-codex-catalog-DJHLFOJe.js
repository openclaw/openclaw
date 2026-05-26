import { t as OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url-UKY1cn1G.js";
//#region extensions/openai/openai-codex-catalog.ts
const OPENAI_CODEX_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
function buildOpenAICodexProvider() {
	return {
		baseUrl: OPENAI_CODEX_BASE_URL,
		api: "openai-codex-responses",
		models: []
	};
}
//#endregion
export { buildOpenAICodexProvider as t };
