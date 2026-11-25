// OpenRouter OAuth support exchanges PKCE browser login codes for API keys.
import { extractErrorCode, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  generatePkceVerifierChallenge,
  ProviderAuthFailure,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { waitForLocalOAuthCallback } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import {
  generateOAuthState,
  parseOAuthAuthorizationInput,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "openrouter";
const OPENROUTER_OAUTH_METHOD_ID = "oauth";
const OPENROUTER_OAUTH_CHOICE_ID = "openrouter-oauth";
const OPENROUTER_OAUTH_AUTHORIZE_URL = "https://openrouter.ai/auth";
const OPENROUTER_OAUTH_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_OAUTH_CALLBACK_PORT = 3000;
const OPENROUTER_OAUTH_CALLBACK_PATH = "/openrouter-oauth/callback";
const OPENROUTER_OAUTH_REDIRECT_URI = `http://localhost:${OPENROUTER_OAUTH_CALLBACK_PORT}${OPENROUTER_OAUTH_CALLBACK_PATH}`;
const OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD = "S256";

const OPENROUTER_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OPENROUTER_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const OPENROUTER_OAUTH_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const OPENROUTER_OAUTH_PROFILE_ID = "openrouter:default";

type OpenRouterOAuthKeyResult = {
  key: string;
  userId?: string;
};

function extractOpenRouterError(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct =
    normalizeOptionalString(value.message) ?? normalizeOptionalString(value.error_description);
  if (direct) {
    return direct;
  }
  const error = value.error;
  if (typeof error === "string") {
    return error.trim() || undefined;
  }
  if (isRecord(error)) {
    return normalizeOptionalString(error.message) ?? normalizeOptionalString(error.code);
  }
  return undefined;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.ok) {
    return await readProviderJsonResponse(response, "OpenRouter OAuth key exchange");
  }
  const text = await readResponseTextLimited(
    response,
    OPENROUTER_OAUTH_ERROR_BODY_LIMIT_BYTES,
  ).catch(() => "");
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseOpenRouterKeyResponse(value: unknown): OpenRouterOAuthKeyResult {
  if (!isRecord(value)) {
    throw new Error("OpenRouter OAuth key exchange returned an unexpected response.");
  }
  const key = normalizeOptionalString(value.key);
  if (!key) {
    throw new Error("OpenRouter OAuth key exchange returned no API key.");
  }
  const userId = normalizeOptionalString(value.user_id) ?? normalizeOptionalString(value.userId);
  return {
    key,
    ...(userId ? { userId } : {}),
  };
}

async function loginOpenRouterOAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting OpenRouter OAuth...");
  try {
    const pkce = generatePkceVerifierChallenge();
    const state = generateOAuthState();
    const buildAuthorizationUrl = (redirectUrl: string) => {
      const callbackUrl = new URL(redirectUrl);
      callbackUrl.searchParams.set("state", state);
      const url = new URL(OPENROUTER_OAUTH_AUTHORIZE_URL);
      url.searchParams.set("callback_url", callbackUrl.toString());
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD);
      return url.toString();
    };
    const code = await (async () => {
      if (ctx.oauth.authorize) {
        const result = await ctx.oauth.authorize({
          state,
          timeoutMs: OPENROUTER_OAUTH_TIMEOUT_MS,
          buildAuthorizationUrl,
        });
        return result.code;
      }

      const authorizeUrl = buildAuthorizationUrl(OPENROUTER_OAUTH_REDIRECT_URI);
      // OpenRouter nests the state inside callback_url, so it is passed as the expected state.
      const promptForCode = async () => {
        const input = await ctx.prompter.text({
          message: "Paste the OpenRouter redirect URL",
          placeholder: `${OPENROUTER_OAUTH_REDIRECT_URI}?state=...&code=...`,
          validate: (value) => {
            try {
              parseOAuthAuthorizationInput(value, { state, signInUrl: authorizeUrl });
              return undefined;
            } catch (error) {
              return formatErrorMessage(error);
            }
          },
        });
        return parseOAuthAuthorizationInput(input, { state }).code;
      };
      ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${authorizeUrl}\n`);
      // onProgress keeps the listener open after a refusal; only a listen failure or a
      // timeout falls back to paste.
      const callback = ctx.isRemote
        ? undefined
        : waitForLocalOAuthCallback({
            expectedState: state,
            timeoutMs: OPENROUTER_OAUTH_TIMEOUT_MS,
            port: OPENROUTER_OAUTH_CALLBACK_PORT,
            callbackPath: OPENROUTER_OAUTH_CALLBACK_PATH,
            redirectUri: OPENROUTER_OAUTH_REDIRECT_URI,
            successTitle: "OpenRouter authorization received",
            onProgress: (message, reason) => progress.update(message, reason),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }).then(
            (result) => result.code,
            async (error: unknown) => {
              if (ctx.signal?.aborted) {
                throw error;
              }
              const portBusy = extractErrorCode(error) === "EADDRINUSE";
              if (!portBusy) {
                progress.update("OAuth callback not detected; waiting for redirect URL...");
              }
              const pasted = promptForCode();
              // Said once the paste prompt is open, so setup apps show it beside that field.
              if (portBusy) {
                progress.update(
                  new ProviderAuthFailure("callback_port_busy").message,
                  "callback_port_busy",
                );
              }
              return await pasted;
            },
          );
      await ctx.openUrl(authorizeUrl).catch(() => undefined);
      return await (callback ?? promptForCode());
    })();
    progress.update("Exchanging OpenRouter OAuth code...");
    ctx.signal?.throwIfAborted();
    ctx.assertCurrent?.();
    const signal = ctx.signal;
    const { response, release } = await fetchWithSsrFGuard({
      url: OPENROUTER_OAUTH_TOKEN_URL,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          code,
          code_verifier: pkce.verifier,
          code_challenge_method: OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(OPENROUTER_OAUTH_FETCH_TIMEOUT_MS)])
          : AbortSignal.timeout(OPENROUTER_OAUTH_FETCH_TIMEOUT_MS),
      },
      beforeRequest: () => ctx.assertCurrent?.(),
      // The endpoint is fixed; preserve operator-configured proxy routing.
      mode: "trusted_env_proxy",
      auditContext: "openrouter.oauth",
    });
    let token: OpenRouterOAuthKeyResult;
    try {
      const body = await readResponseBody(response);
      if (!response.ok) {
        const message = extractOpenRouterError(body);
        throw new Error(
          `OpenRouter OAuth key exchange failed (${response.status})${message ? `: ${message}` : ""}`,
        );
      }
      token = parseOpenRouterKeyResponse(body);
    } finally {
      await release();
    }
    progress.stop("OpenRouter credential received");

    const metadata = {
      authFlow: "oauth-pkce",
      ...(token.userId ? { userId: token.userId } : {}),
    };
    const credential = {
      ...buildApiKeyCredential(PROVIDER_ID, token.key, metadata),
      displayName: token.userId ? `OpenRouter ${token.userId}` : "OpenRouter OAuth",
    };

    return {
      profiles: [{ profileId: OPENROUTER_OAUTH_PROFILE_ID, credential }],
      configPatch: applyOpenrouterConfig(ctx.config),
      defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
      notes: [
        "OpenRouter OAuth issued an OpenRouter API key for the default OpenRouter auth profile.",
        "Sign in again to rotate that key, or use the API-key setup path for a key you manage manually.",
      ],
    };
  } catch (err) {
    progress.stop();
    throw err;
  }
}

export function createOpenRouterOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: OPENROUTER_OAUTH_METHOD_ID,
    label: "OpenRouter OAuth",
    hint: "Browser sign-in",
    kind: "oauth",
    wizard: {
      choiceId: OPENROUTER_OAUTH_CHOICE_ID,
      choiceLabel: "OpenRouter OAuth",
      choiceHint: "Browser sign-in",
      groupId: PROVIDER_ID,
      groupLabel: "OpenRouter",
      groupHint: "OAuth or API key",
      methodId: OPENROUTER_OAUTH_METHOD_ID,
      onboardingScopes: ["text-inference", "music-generation"],
      onboardingFeatured: true,
    },
    run: loginOpenRouterOAuth,
  };
}
