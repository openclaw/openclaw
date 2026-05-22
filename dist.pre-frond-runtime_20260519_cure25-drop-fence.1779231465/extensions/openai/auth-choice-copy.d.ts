//#region extensions/openai/auth-choice-copy.d.ts
declare const OPENAI_API_KEY_LABEL = "OpenAI API Key";
declare const OPENAI_CHATGPT_LOGIN_LABEL = "ChatGPT Login";
declare const OPENAI_CHATGPT_LOGIN_HINT = "Sign in with your ChatGPT or Codex subscription";
declare const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "ChatGPT Device Pairing";
declare const OPENAI_CHATGPT_DEVICE_PAIRING_HINT = "Pair your ChatGPT account in browser with a device code";
declare const OPENAI_CODEX_API_KEY_BACKUP_LABEL = "OpenAI API Key Backup";
declare const OPENAI_CODEX_API_KEY_BACKUP_HINT = "Use an OpenAI API key when your Codex subscription is unavailable";
declare const OPENAI_CODEX_LOGIN_LABEL = "ChatGPT/Codex Browser Login";
declare const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
declare const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "ChatGPT/Codex Device Pairing";
declare const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";
declare const OPENAI_API_KEY_WIZARD_GROUP: {
  readonly groupId: "openai";
  readonly groupLabel: "OpenAI";
  readonly groupHint: "Direct API key";
};
declare const OPENAI_ACCOUNT_WIZARD_GROUP: {
  readonly groupId: "openai";
  readonly groupLabel: "OpenAI";
  readonly groupHint: "ChatGPT/Codex sign-in or API key";
};
declare const OPENAI_CODEX_WIZARD_GROUP: {
  readonly groupId: "openai";
  readonly groupLabel: "OpenAI";
  readonly groupHint: "ChatGPT/Codex sign-in or API key";
};
//#endregion
export { OPENAI_ACCOUNT_WIZARD_GROUP, OPENAI_API_KEY_LABEL, OPENAI_API_KEY_WIZARD_GROUP, OPENAI_CHATGPT_DEVICE_PAIRING_HINT, OPENAI_CHATGPT_DEVICE_PAIRING_LABEL, OPENAI_CHATGPT_LOGIN_HINT, OPENAI_CHATGPT_LOGIN_LABEL, OPENAI_CODEX_API_KEY_BACKUP_HINT, OPENAI_CODEX_API_KEY_BACKUP_LABEL, OPENAI_CODEX_DEVICE_PAIRING_HINT, OPENAI_CODEX_DEVICE_PAIRING_LABEL, OPENAI_CODEX_LOGIN_HINT, OPENAI_CODEX_LOGIN_LABEL, OPENAI_CODEX_WIZARD_GROUP };