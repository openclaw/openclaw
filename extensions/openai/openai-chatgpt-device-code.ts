import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { positiveSecondsToSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import { ProviderAuthFailure } from "openclaw/plugin-sdk/provider-auth";
import {
  inspectTlsCertificateError,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import type { OAuthCredentials } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  classifyTransientNetworkErrorCode,
  sleepWithAbort,
} from "openclaw/plugin-sdk/retry-runtime";
import {
  asNullableObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAICredentials } from "./openai-chatgpt-oauth-flow.runtime.js";
import {
  createOpenAISignInFailure,
  exchangeOpenAIAuthorizationCode,
  normalizeTokenErrorSummary,
} from "./openai-chatgpt-oauth-token.runtime.js";
import { OPENAI_CODEX_CLIENT_ID, withOpenAIOAuthResponse } from "./openai-oauth-http.runtime.js";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS = 30_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const OPENAI_CODEX_DEVICE_JSON_BODY_LIMIT_BYTES = 256 * 1024;

function resolveOpenAICodexDeviceCodeHeaders(contentType: string): Record<string, string> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  return {
    "Content-Type": contentType,
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

type OpenAICodexDeviceCodePrompt = {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
};

type DeviceCodeHttpResult = {
  ok: boolean;
  status: number;
  bodyText: string;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asNullableObjectRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function resolveNextDeviceCodePollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - performance.now());
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

function resolveDeviceCodePollRequestTimeoutMs(deadlineMs: number): number {
  return Math.min(
    OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS,
    Math.max(0, deadlineMs - performance.now()),
  );
}

function isDeviceCodeOperationTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isTransientTransportError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (candidate) => [candidate.cause]).some(
    (candidate) => classifyTransientNetworkErrorCode(extractErrorCode(candidate)) !== undefined,
  );
}

function deviceCodeFailure(result: DeviceCodeHttpResult, rejected?: "device_code_denied") {
  const body = parseJsonObject(result.bodyText);
  // Same error shape as the token endpoint: `error` may be a string or `{ code, message }`.
  const error = asNullableObjectRecord(body?.error);
  return createOpenAISignInFailure(
    {
      status: result.status,
      code: normalizeOptionalString(error?.code ?? body?.error)?.toLowerCase(),
      summary: normalizeTokenErrorSummary(
        error?.message ?? body?.error_description ?? body?.error ?? result.bodyText,
      ),
    },
    rejected,
  );
}

function rethrowIfDeviceCodeCallerAborted(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : error;
  }
}

async function runOpenAICodexDeviceRequest(params: {
  url: string;
  init: Omit<RequestInit, "signal">;
  timeoutMs: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<DeviceCodeHttpResult> {
  const guardedOptions = {
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    beforeRequest: params.assertCurrent,
    requireHttps: true,
    auditContext: "openai-chatgpt-device-code",
  };
  return await withOpenAIOAuthResponse(
    shouldUseEnvHttpProxyForUrl(params.url)
      ? withTrustedEnvProxyGuardedFetchMode(guardedOptions)
      : guardedOptions,
    async (response) => ({
      ok: response.ok,
      status: response.status,
      bodyText: await readResponseTextLimited(
        response,
        response.ok
          ? OPENAI_CODEX_DEVICE_JSON_BODY_LIMIT_BYTES
          : OPENAI_CODEX_DEVICE_ERROR_BODY_LIMIT_BYTES,
        { chunkTimeoutMs: params.timeoutMs },
      ),
    }),
  );
}

export async function loginOpenAICodexDeviceCode(params: {
  onVerification: (prompt: OpenAICodexDeviceCodePrompt) => Promise<void> | void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<OAuthCredentials | null> {
  const { signal, assertCurrent } = params;
  params.onProgress?.("Requesting device code…");
  signal?.throwIfAborted();
  let userCodeResult: DeviceCodeHttpResult;
  try {
    userCodeResult = await runOpenAICodexDeviceRequest({
      url: `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
      init: {
        method: "POST",
        headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
        body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      },
      timeoutMs: OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      assertCurrent,
    });
  } catch (error) {
    rethrowIfDeviceCodeCallerAborted(signal, error);
    // The first request to auth.openai.com is also the host TLS check for both sign-in paths.
    if (inspectTlsCertificateError(error)) {
      throw new ProviderAuthFailure("host_network_blocked", {
        providerDetail:
          "This computer cannot verify OpenAI's TLS certificate, so OpenClaw cannot reach OpenAI to sign in.",
        cause: error,
      });
    }
    if (isDeviceCodeOperationTimeoutError(error) || isTransientTransportError(error)) {
      throw new ProviderAuthFailure("network", { cause: error });
    }
    throw error;
  }
  // Codex: 404 here means device code login is not enabled for this server.
  if (userCodeResult.status === 404) {
    return null;
  }
  if (!userCodeResult.ok) {
    throw deviceCodeFailure(userCodeResult);
  }
  const userCodeBody = parseJsonObject(userCodeResult.bodyText);
  const deviceAuthId = normalizeOptionalString(userCodeBody?.device_auth_id);
  const userCode =
    normalizeOptionalString(userCodeBody?.user_code) ??
    normalizeOptionalString(userCodeBody?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }
  const intervalMs =
    positiveSecondsToSafeMilliseconds(userCodeBody?.interval) ??
    OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS;

  await params.onVerification({
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    userCode,
    expiresInMs: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  });

  params.onProgress?.("Waiting for device authorization…");
  const pollOpenAICodexDeviceCode = async () => {
    // Keep the polling budget independent of wall-clock corrections. Whether
    // suspended time counts toward performance.now() depends on the host runtime.
    const deadline = performance.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;

    while (performance.now() < deadline) {
      signal?.throwIfAborted();
      const requestTimeoutMs = resolveDeviceCodePollRequestTimeoutMs(deadline);
      if (requestTimeoutMs <= 0) {
        break;
      }

      let result: DeviceCodeHttpResult | undefined;
      try {
        result = await runOpenAICodexDeviceRequest({
          url: `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
          init: {
            method: "POST",
            headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
            body: JSON.stringify({
              device_auth_id: deviceAuthId,
              user_code: userCode,
            }),
          },
          timeoutMs: requestTimeoutMs,
          ...(signal ? { signal } : {}),
          assertCurrent,
        });
      } catch (error) {
        rethrowIfDeviceCodeCallerAborted(signal, error);
        if (isDeviceCodeOperationTimeoutError(error)) {
          continue;
        }
        if (!isTransientTransportError(error)) {
          throw error;
        }
      }

      if (result?.ok) {
        const body = parseJsonObject(result.bodyText);
        const authorizationCode = normalizeOptionalString(body?.authorization_code);
        const codeVerifier = normalizeOptionalString(body?.code_verifier);
        if (!authorizationCode || !codeVerifier) {
          throw new Error("OpenAI device authorization response was missing the exchange code.");
        }
        return {
          authorizationCode,
          codeVerifier,
        };
      }

      // Codex contract: only 403/404 mean pending; any other answer ends this code.
      if (result && result.status !== 403 && result.status !== 404) {
        throw deviceCodeFailure(result, "device_code_denied");
      }

      await waitForDeviceCodePoll(resolveNextDeviceCodePollDelayMs(intervalMs, deadline), signal);
    }

    throw new ProviderAuthFailure("device_code_expired");
  };
  const authorization = await pollOpenAICodexDeviceCode();

  params.onProgress?.("Exchanging device code…");
  const result = await exchangeOpenAIAuthorizationCode(
    authorization.authorizationCode,
    authorization.codeVerifier,
    OPENAI_CODEX_DEVICE_CALLBACK_URL,
    { signal, assertCurrent },
  );
  if (result.type !== "success") {
    // A retired owner's refused request reports the retirement, not a network failure.
    assertCurrent?.();
  }
  return resolveOpenAICredentials(result);
}

function waitForDeviceCodePoll(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return sleepWithAbort(Math.max(1, ms), signal).catch(() => {
    throw signal?.reason instanceof Error ? signal.reason : new Error("Device login cancelled");
  });
}
