import { bt as ProviderAuthContext } from "../../types-Dggwf5Fv.js";
import { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

//#region extensions/openai/openai-codex-oauth.runtime.d.ts
declare function loginOpenAICodexOAuth(params: {
  prompter: ProviderAuthContext["prompter"];
  runtime: ProviderAuthContext["runtime"];
  oauth: ProviderAuthContext["oauth"];
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null>;
//#endregion
export { loginOpenAICodexOAuth };