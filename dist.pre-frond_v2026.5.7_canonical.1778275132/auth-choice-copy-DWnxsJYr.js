//#region extensions/openai/auth-choice-copy.ts
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_CODEX_LOGIN_LABEL = "OpenAI Codex Browser Login";
const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "OpenAI Codex Device Pairing";
const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";
const OPENAI_API_KEY_WIZARD_GROUP = {
	groupId: "openai",
	groupLabel: "OpenAI",
	groupHint: "Direct API key"
};
const OPENAI_CODEX_WIZARD_GROUP = {
	groupId: "openai-codex",
	groupLabel: "OpenAI Codex",
	groupHint: "ChatGPT/Codex sign-in"
};
//#endregion
export { OPENAI_CODEX_LOGIN_HINT as a, OPENAI_CODEX_DEVICE_PAIRING_LABEL as i, OPENAI_API_KEY_WIZARD_GROUP as n, OPENAI_CODEX_LOGIN_LABEL as o, OPENAI_CODEX_DEVICE_PAIRING_HINT as r, OPENAI_CODEX_WIZARD_GROUP as s, OPENAI_API_KEY_LABEL as t };
