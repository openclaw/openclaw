//#region extensions/openai/openai-codex-device-code.d.ts
type OpenAICodexDeviceCodePrompt = {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
};
type OpenAICodexDeviceCodeCredentials = {
  access: string;
  refresh: string;
  expires: number;
};
declare function loginOpenAICodexDeviceCode(params: {
  fetchFn?: typeof fetch;
  onVerification: (prompt: OpenAICodexDeviceCodePrompt) => Promise<void> | void;
  onProgress?: (message: string) => void;
}): Promise<OpenAICodexDeviceCodeCredentials>;
//#endregion
export { loginOpenAICodexDeviceCode };