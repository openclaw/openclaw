import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  ProviderAuthFailure,
  providerAuthFailureFromOAuthError,
  type ProviderAuthFailureReason,
} from "openclaw/plugin-sdk/provider-auth";
import {
  createOAuthLoginCancelledError,
  createOAuthRefreshError,
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  parseOAuthAuthorizationInput,
  resolveOpenAICodexAuthIdentity,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
  type OAuthCredentials,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  createOpenAISignInFailure,
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";
import { OPENAI_CODEX_CLIENT_ID } from "./openai-oauth-http.runtime.js";

const LOOPBACK_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const loadOAuthCallbackServer = createLazyRuntimeModule(() =>
  import("openclaw/plugin-sdk/provider-auth-runtime").then(
    ({ startProviderOAuthLoopbackCallbackServer }) => startProviderOAuthLoopbackCallbackServer,
  ),
);

export function resolveOpenAICallbackHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.OPENCLAW_OAUTH_CALLBACK_HOST?.trim() || "localhost";
  if (!LOOPBACK_CALLBACK_HOSTS.has(host)) {
    throw new Error("OpenAI Codex OAuth callback host must be localhost, 127.0.0.1, or ::1");
  }
  return host;
}

/** Maps a token result to credentials; sign-in and refresh failures keep their own shapes. */
export function resolveOpenAICredentials(
  result: Awaited<ReturnType<typeof refreshOpenAIAccessToken>>,
): OAuthCredentials {
  if (result.type !== "success") {
    if (result.cancelled) {
      throw createOAuthLoginCancelledError();
    }
    if (result.operation === "exchange") {
      throw createOpenAISignInFailure(result);
    }
    const facts = [
      result.status ? `HTTP ${result.status}` : undefined,
      result.code ? `code=${result.code}` : undefined,
      result.errorType ? `type=${result.errorType}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const diagnostic =
      facts.length > 0
        ? `OpenAI Codex token ${result.operation} failed (${facts.join("; ")}).`
        : undefined;
    throw Object.assign(new Error([result.summary, diagnostic].filter(Boolean).join("\n\n")), {
      ...(result.oauthRefreshOutcome ? { oauthRefreshOutcome: result.oauthRefreshOutcome } : {}),
      oauthRefreshFailure: {
        summary: result.summary,
        ...(result.errorType ? { errorType: result.errorType } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.status ? { status: result.status } : {}),
      },
    });
  }
  const accountId = resolveOpenAICodexAuthIdentity({ access: result.access }).accountId;
  if (!accountId) {
    throw createOAuthRefreshError("Failed to extract accountId from token. Sign in again.", {
      version: 1,
      phase: "after-token-response",
      outcome: "unknown",
    });
  }
  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
  };
}

export async function loginOpenAICodex(options: {
  onAuth: (info: { url: string; instructions?: string }) => Promise<void> | void;
  // Manual entry races the browser callback; either can complete the login.
  onManualCodeInput: (callback: { listening: boolean }) => Promise<string>;
  // A browser refusal keeps the callback listening and a busy port leaves only manual entry;
  // `reason` reports either while the manual entry prompt stays open.
  onProgress?: (message: string, reason?: ProviderAuthFailureReason) => void;
  originator?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<OAuthCredentials> {
  options.assertCurrent?.();
  throwIfOAuthLoginAborted(options.signal);
  const callbackHost = resolveOpenAICallbackHost();
  const redirectUri = `http://${callbackHost === "::1" ? "[::1]" : callbackHost}:1455/auth/callback`;
  const { verifier, challenge } = await generatePKCE();
  const state = generateOAuthState();
  // Codex authorize parameters: its consent page rejects requests without them.
  const url = new URL("https://auth.openai.com/oauth/authorize");
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: options.originator ?? "openclaw",
  })) {
    url.searchParams.set(key, value);
  }
  const startCallbackServer = await loadOAuthCallbackServer();
  options.assertCurrent?.();
  throwIfOAuthLoginAborted(options.signal);
  let server: Awaited<ReturnType<typeof startCallbackServer>> | undefined;
  let portBusy = false;
  try {
    server = await startCallbackServer({
      redirectUrl: redirectUri,
      expectedState: state,
      bindOnlyHostname: callbackHost,
      signal: options.signal,
      onRefusal: (error) => {
        const failure = providerAuthFailureFromOAuthError(error);
        options.onProgress?.(failure.message, failure.reason);
      },
      renderError: (message) => ({
        body: oauthErrorHtml(message),
        contentType: "text/html; charset=utf-8",
      }),
    });
  } catch (error) {
    // An unavailable callback port still permits manual entry; retired owners do not.
    options.assertCurrent?.();
    throwIfOAuthLoginAborted(options.signal);
    portBusy = extractErrorCode(error) === "EADDRINUSE";
  }
  const waitForLogin = <T>(promise: Promise<T>) => withOAuthLoginAbort(promise, options.signal);
  try {
    options.assertCurrent?.();
    throwIfOAuthLoginAborted(options.signal);
    await waitForLogin(
      Promise.resolve(
        options.onAuth({
          url: url.toString(),
          instructions: "A browser window should open. Complete login to finish.",
        }),
      ),
    );
    throwIfOAuthLoginAborted(options.signal);
    // onRefusal keeps the listener open after a refusal, so this settles with a code.
    const callbackPromise = server?.waitForCallback().then((result) => {
      if (result.type === "oauth_error") {
        throw providerAuthFailureFromOAuthError(result.error);
      }
      return result.code;
    });
    // Closing the server after manual entry can reject the losing callback wait.
    void callbackPromise?.catch(() => undefined);
    const manualPromise = options
      .onManualCodeInput({ listening: server !== undefined })
      .then((input) => parseOAuthAuthorizationInput(input, { state }).code);
    if (portBusy) {
      // Said once the manual entry prompt is open, so setup apps show it beside that field.
      options.onProgress?.(
        new ProviderAuthFailure("callback_port_busy").message,
        "callback_port_busy",
      );
    }
    const code = await waitForLogin(
      callbackPromise ? Promise.race([callbackPromise, manualPromise]) : manualPromise,
    );
    const result = await exchangeOpenAIAuthorizationCode(code, verifier, redirectUri, {
      signal: options.signal,
      assertCurrent: options.assertCurrent,
    });
    if (result.type !== "success") {
      // A retired owner's refused request reports the retirement, not a network failure.
      options.assertCurrent?.();
    }
    return resolveOpenAICredentials(result);
  } finally {
    await server?.close();
  }
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  return resolveOpenAICredentials(await refreshOpenAIAccessToken(refreshToken));
}
