import { OAuthCredentials } from "@earendil-works/pi-ai";

//#region extensions/chutes/oauth.d.ts
type OAuthPrompt = {
  message: string;
  placeholder?: string;
};
type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};
type ChutesStoredOAuth = OAuthCredentials & {
  accountId?: string;
  clientId?: string;
};
declare function loginChutes(params: {
  app: ChutesOAuthAppConfig;
  manual?: boolean;
  timeoutMs?: number;
  createState?: () => string;
  onAuth: (event: {
    url: string;
  }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  fetchFn?: typeof fetch;
}): Promise<ChutesStoredOAuth>;
//#endregion
export { loginChutes };