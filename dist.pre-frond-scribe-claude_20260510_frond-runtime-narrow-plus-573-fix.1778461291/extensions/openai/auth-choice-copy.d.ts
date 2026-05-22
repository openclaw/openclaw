//#region extensions/openai/auth-choice-copy.d.ts
declare const OPENAI_API_KEY_LABEL = "OpenAI API Key";
declare const OPENAI_CODEX_LOGIN_LABEL = "OpenAI Codex Browser Login";
declare const OPENAI_CODEX_LOGIN_HINT = "Sign in with OpenAI in your browser";
declare const OPENAI_CODEX_DEVICE_PAIRING_LABEL = "OpenAI Codex Device Pairing";
declare const OPENAI_CODEX_DEVICE_PAIRING_HINT = "Pair in browser with a device code";
declare const OPENAI_API_KEY_WIZARD_GROUP: {
  readonly groupId: "openai";
  readonly groupLabel: "OpenAI";
  readonly groupHint: "Direct API key";
};
declare const OPENAI_CODEX_WIZARD_GROUP: {
  readonly groupId: "openai-codex";
  readonly groupLabel: "OpenAI Codex";
  readonly groupHint: "ChatGPT/Codex sign-in";
};
//#endregion
export { OPENAI_API_KEY_LABEL, OPENAI_API_KEY_WIZARD_GROUP, OPENAI_CODEX_DEVICE_PAIRING_HINT, OPENAI_CODEX_DEVICE_PAIRING_LABEL, OPENAI_CODEX_LOGIN_HINT, OPENAI_CODEX_LOGIN_LABEL, OPENAI_CODEX_WIZARD_GROUP };