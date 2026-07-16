import "./oauth.js";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";

type CallbackResult = { code: string; state: string };
type LoginOptions = {
  createPkce?: () => { verifier: string; challenge: string };
  createState?: () => string;
  fetchImpl?: typeof fetch;
  waitForCallback?: (params: {
    expectedState: string;
    timeoutMs?: number;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
  }) => Promise<CallbackResult>;
};

type OpenRouterOAuthTestApi = {
  buildOpenRouterOAuthAuthorizeUrl: (params: { codeChallenge: string; state: string }) => string;
  buildOpenRouterOAuthRedirectUri: (params: { state: string }) => string;
  exchangeOpenRouterOAuthCode: (params: {
    code: string;
    codeVerifier: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<{ key: string; userId?: string }>;
  loginOpenRouterOAuth: (
    ctx: ProviderAuthContext,
    options?: LoginOptions,
  ) => Promise<ProviderAuthResult>;
  OPENROUTER_OAUTH_CALLBACK_PATH: string;
  OPENROUTER_OAUTH_CALLBACK_PORT: number;
  OPENROUTER_OAUTH_CHOICE_ID: string;
  OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD: string;
  OPENROUTER_OAUTH_REDIRECT_URI: string;
  OPENROUTER_OAUTH_TOKEN_URL: string;
  parseOpenRouterOAuthCallbackInput: (input: string, expectedState: string) => CallbackResult;
  waitForOpenRouterOAuthCallback: NonNullable<LoginOptions["waitForCallback"]>;
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.openrouterOAuthTestApi"));
if (!api) {
  throw new Error("OpenRouter OAuth test API is unavailable");
}

export const {
  buildOpenRouterOAuthAuthorizeUrl,
  buildOpenRouterOAuthRedirectUri,
  exchangeOpenRouterOAuthCode,
  loginOpenRouterOAuth,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_CALLBACK_PORT,
  OPENROUTER_OAUTH_CHOICE_ID,
  OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD,
  OPENROUTER_OAUTH_REDIRECT_URI,
  OPENROUTER_OAUTH_TOKEN_URL,
  parseOpenRouterOAuthCallbackInput,
  waitForOpenRouterOAuthCallback,
} = api as OpenRouterOAuthTestApi;
