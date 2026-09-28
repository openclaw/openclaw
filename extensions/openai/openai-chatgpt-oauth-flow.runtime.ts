import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-auth";
import {
  createOAuthLoginCancelledError,
  oauthErrorHtml,
  oauthSuccessHtml,
  parseOAuthAuthorizationInput,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
  type OAuthCredentials,
  type OAuthPrompt,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  createOpenAIAuthorizationFlow,
  resolveOpenAICallbackHost,
  resolveOpenAIRedirectUri,
} from "./openai-chatgpt-oauth-authorization.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";

const CALLBACK_HOST = resolveOpenAICallbackHost();
const REDIRECT_URI = resolveOpenAIRedirectUri(CALLBACK_HOST);
const MANUAL_PROMPT_FALLBACK_MS = 15_000;

const loadOAuthCallbackServer = createLazyRuntimeModule(() =>
  import("openclaw/plugin-sdk/provider-auth-runtime").then(
    ({ startProviderOAuthLoopbackCallbackServer }) => startProviderOAuthLoopbackCallbackServer,
  ),
);

function waitForManualPromptFallback(signal?: AbortSignal): Promise<null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createOAuthLoginCancelledError());
      return;
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createOAuthLoginCancelledError());
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, MANUAL_PROMPT_FALLBACK_MS);

    signal?.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

function parseAuthorizationCode(input: string, state: string): string | undefined {
  const parsed = parseOAuthAuthorizationInput(input);
  if (parsed.state && parsed.state !== state) {
    throw new Error("State mismatch");
  }
  return parsed.code;
}

async function promptForAuthorizationCode(
  onPrompt: (prompt: OAuthPrompt) => Promise<string>,
  state: string,
): Promise<string | undefined> {
  return parseAuthorizationCode(
    await onPrompt({ message: "Paste the authorization code (or full redirect URL):" }),
    state,
  );
}

function resolveOpenAICredentials(
  result: Awaited<ReturnType<typeof refreshOpenAIAccessToken>>,
): OAuthCredentials {
  if (result.type !== "success") {
    if (result.cancelled) {
      throw createOAuthLoginCancelledError();
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
    throw new Error("Failed to extract accountId from token");
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
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  // Manual entry races the browser callback; either can complete the login.
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<OAuthCredentials> {
  options.assertCurrent?.();
  throwIfOAuthLoginAborted(options.signal);
  const { verifier, redirectUri, state, url } = await createOpenAIAuthorizationFlow(
    options.originator ?? "openclaw",
    REDIRECT_URI,
  );
  const startCallbackServer = await loadOAuthCallbackServer();
  options.assertCurrent?.();
  throwIfOAuthLoginAborted(options.signal);
  let server: Awaited<ReturnType<typeof startCallbackServer>> | undefined;
  try {
    server = await startCallbackServer({
      redirectUrl: REDIRECT_URI,
      expectedState: state,
      bindOnlyHostname: CALLBACK_HOST,
      signal: options.signal,
      renderSuccess: () => ({
        body: oauthSuccessHtml("OpenAI authentication completed. You can close this window."),
        contentType: "text/html; charset=utf-8",
      }),
      renderError: (message) => ({
        body: oauthErrorHtml(message),
        contentType: "text/html; charset=utf-8",
      }),
    });
  } catch {
    // An unavailable callback port still permits manual entry; retired owners do not.
    options.assertCurrent?.();
    throwIfOAuthLoginAborted(options.signal);
  }
  let cancelWait!: () => void;
  const cancelledWait = new Promise<null>((resolve) => {
    cancelWait = () => resolve(null);
  });
  let code: string | undefined;
  try {
    options.assertCurrent?.();
    throwIfOAuthLoginAborted(options.signal);
    await withOAuthLoginAbort(
      Promise.resolve(
        options.onAuth({
          url,
          instructions: "A browser window should open. Complete login to finish.",
        }),
      ),
      options.signal,
      cancelWait,
    );
    throwIfOAuthLoginAborted(options.signal);
    const callbackPromise = Promise.race([
      server
        ? server.waitForCallback().then((result) => {
            if (result.type === "oauth_error") {
              throw new Error("OpenAI authorization was not completed.");
            }
            return { code: result.code };
          })
        : Promise.resolve(null),
      cancelledWait,
    ]);
    void callbackPromise.catch(() => undefined);

    if (options.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          cancelWait();
        })
        .catch((err: unknown) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          cancelWait();
        });

      const result = await withOAuthLoginAbort(callbackPromise, options.signal, cancelWait);

      if (!result?.code && !manualCode && !manualError) {
        await withOAuthLoginAbort(manualPromise, options.signal, cancelWait);
      }
      if (manualError) {
        throw manualError;
      }
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        code = parseAuthorizationCode(manualCode, state);
      }
    } else {
      const result = await withOAuthLoginAbort(
        Promise.race([callbackPromise, waitForManualPromptFallback(options.signal)]),
        options.signal,
        cancelWait,
      );
      if (result?.code) {
        code = result.code;
      } else {
        const promptCodePromise = promptForAuthorizationCode(options.onPrompt, state).then(
          (promptCode) => {
            cancelWait();
            return promptCode;
          },
        );
        code = await withOAuthLoginAbort(
          Promise.race([callbackPromise.then((callback) => callback?.code), promptCodePromise]),
          options.signal,
          cancelWait,
        );
      }
    }

    if (!code) {
      code = await withOAuthLoginAbort(
        promptForAuthorizationCode(options.onPrompt, state),
        options.signal,
        cancelWait,
      );
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    return resolveOpenAICredentials(
      await exchangeOpenAIAuthorizationCode(code, verifier, redirectUri, {
        signal: options.signal,
        assertCurrent: options.assertCurrent,
      }),
    );
  } finally {
    await server?.close();
  }
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  return resolveOpenAICredentials(await refreshOpenAIAccessToken(refreshToken));
}
