//#region extensions/openai/auth-choice-copy.ts
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_CHATGPT_LOGIN_LABEL = "ChatGPT Login";
const OPENAI_CHATGPT_LOGIN_HINT = "Sign in with your ChatGPT or Codex subscription";
const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "ChatGPT Device Pairing";
const OPENAI_CHATGPT_DEVICE_PAIRING_HINT = "Pair your ChatGPT account in browser with a device code";
const OPENAI_CODEX_API_KEY_BACKUP_LABEL = "OpenAI API Key Backup";
const OPENAI_CODEX_API_KEY_BACKUP_HINT = "Use an OpenAI API key when your Codex subscription is unavailable";
const OPENAI_CODEX_LOGIN_LABEL = "ChatGPT/Codex Browser Login";
const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "ChatGPT/Codex Device Pairing";
const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";
const OPENAI_UNIFIED_GROUP_HINT = "ChatGPT/Codex sign-in or API key";
const OPENAI_API_KEY_WIZARD_GROUP = {
	groupId: "openai",
	groupLabel: "OpenAI",
	groupHint: "Direct API key"
};
const OPENAI_ACCOUNT_WIZARD_GROUP = {
	groupId: "openai",
	groupLabel: "OpenAI",
	groupHint: OPENAI_UNIFIED_GROUP_HINT
};
const OPENAI_CODEX_WIZARD_GROUP = {
	groupId: "openai",
	groupLabel: "OpenAI",
	groupHint: OPENAI_UNIFIED_GROUP_HINT
};
//#endregion
export { OPENAI_CHATGPT_DEVICE_PAIRING_LABEL as a, OPENAI_CODEX_API_KEY_BACKUP_HINT as c, OPENAI_CODEX_DEVICE_PAIRING_LABEL as d, OPENAI_CODEX_LOGIN_HINT as f, OPENAI_CHATGPT_DEVICE_PAIRING_HINT as i, OPENAI_CODEX_API_KEY_BACKUP_LABEL as l, OPENAI_CODEX_WIZARD_GROUP as m, OPENAI_API_KEY_LABEL as n, OPENAI_CHATGPT_LOGIN_HINT as o, OPENAI_CODEX_LOGIN_LABEL as p, OPENAI_API_KEY_WIZARD_GROUP as r, OPENAI_CHATGPT_LOGIN_LABEL as s, OPENAI_ACCOUNT_WIZARD_GROUP as t, OPENAI_CODEX_DEVICE_PAIRING_HINT as u };
