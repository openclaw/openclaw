import { n as RuntimeEnv } from "./runtime-D0p4Vp8x.js";
import { i as WizardPrompter } from "./prompts-lrXrb5IE.js";
import { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { OAuthCredentials as OAuthCredentials$1 } from "@mariozechner/pi-ai";

//#region src/agents/chutes-oauth.d.ts
type ChutesPkce = {
  verifier: string;
  challenge: string;
};
type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};
declare function generateChutesPkce(): ChutesPkce;
//#endregion
//#region src/commands/chutes-oauth.d.ts
type OAuthPrompt = {
  message: string;
  placeholder?: string;
};
declare function loginChutes$1(params: {
  app: ChutesOAuthAppConfig;
  manual?: boolean;
  timeoutMs?: number;
  createPkce?: typeof generateChutesPkce;
  createState?: () => string;
  onAuth: (event: {
    url: string;
  }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  fetchFn?: typeof fetch;
}): Promise<OAuthCredentials$1>;
//#endregion
//#region src/plugins/provider-openai-codex-oauth.d.ts
declare function loginOpenAICodexOAuth$1(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null>;
//#endregion
//#region src/plugin-sdk/github-copilot-login.d.ts
type FacadeModule = {
  githubCopilotLoginCommand: (opts: {
    profileId?: string;
    yes?: boolean;
    agentDir?: string;
  }, runtime: RuntimeEnv) => Promise<void>;
};
declare const githubCopilotLoginCommand$1: FacadeModule["githubCopilotLoginCommand"];
declare namespace provider_auth_login_runtime_d_exports {
  export { githubCopilotLoginCommand$1 as githubCopilotLoginCommand, loginChutes$1 as loginChutes, loginOpenAICodexOAuth$1 as loginOpenAICodexOAuth };
}
//#endregion
//#region src/plugin-sdk/provider-auth-login.d.ts
type ProviderAuthLoginRuntime = typeof provider_auth_login_runtime_d_exports;
declare const githubCopilotLoginCommand: ProviderAuthLoginRuntime["githubCopilotLoginCommand"];
declare const loginChutes: ProviderAuthLoginRuntime["loginChutes"];
declare const loginOpenAICodexOAuth: ProviderAuthLoginRuntime["loginOpenAICodexOAuth"];
//#endregion
export { loginChutes as n, loginOpenAICodexOAuth as r, githubCopilotLoginCommand as t };