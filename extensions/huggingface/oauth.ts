import {
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  type OAuthCredential,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildOAuthRequestSignal,
  withOAuthLoginAbort,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyHuggingfaceConnectionConfig, HUGGINGFACE_DEFAULT_MODEL_REF } from "./onboard.js";

const ORIGIN = "https://huggingface.co";
const SCOPE = "inference-api";
const REQUEST_TIMEOUT_MS = 30_000;

class HuggingfaceOAuthRequestError extends Error {}

function assertCurrent(ctx: ProviderAuthContext): void {
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
}

function oauthError(error: unknown): Error {
  const messages: Record<string, string> = {
    access_denied: "Authorization was denied. Run login again to retry.",
    expired_token: "The device code expired. Run login again.",
    invalid_client: "Use the client ID of a Hugging Face public OAuth app without a client secret.",
    unauthorized_client: "This Hugging Face OAuth app does not allow the requested grant.",
    invalid_scope: "Enable the inference-api scope for your Hugging Face OAuth app.",
    invalid_grant: "The Hugging Face session expired or was revoked. Run login again.",
  };
  // Provider descriptions may reflect credentials from the request body.
  return new Error(
    `Hugging Face OAuth: ${typeof error === "string" && Object.hasOwn(messages, error) ? messages[error] : "Request failed. Check your OAuth app settings and retry login."}`,
  );
}

async function request(
  endpoint: "device" | "token",
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const requestSignal = buildOAuthRequestSignal({ signal, timeoutMs: REQUEST_TIMEOUT_MS });
  const response = await fetch(`${ORIGIN}/oauth/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: requestSignal,
    redirect: "error",
  }).catch(() => {
    signal?.throwIfAborted();
    throw new HuggingfaceOAuthRequestError(
      "Hugging Face OAuth could not reach the token service. Retry login.",
    );
  });
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    throw new HuggingfaceOAuthRequestError(
      `Hugging Face OAuth is temporarily unavailable (HTTP ${response.status}).`,
    );
  }
  let data: unknown;
  try {
    data = await readProviderJsonResponse<unknown>(response, "Hugging Face OAuth", {
      maxBytes: 64 * 1024,
      signal: requestSignal,
    });
  } catch {
    signal?.throwIfAborted();
    throw new HuggingfaceOAuthRequestError(
      `Hugging Face OAuth returned an invalid response (HTTP ${response.status}). Retry login.`,
    );
  }
  signal?.throwIfAborted();
  if (requestSignal.aborted) {
    throw new HuggingfaceOAuthRequestError("Hugging Face OAuth request timed out. Retry login.");
  }
  if (!isRecord(data)) {
    throw new HuggingfaceOAuthRequestError(
      "Hugging Face OAuth returned an invalid response. Retry login.",
    );
  }
  if (!response.ok && !data.error) {
    throw new HuggingfaceOAuthRequestError(
      `Hugging Face OAuth request failed (HTTP ${response.status}).`,
    );
  }
  return data;
}

function parseToken(data: Record<string, unknown>, now: number) {
  if (data.error) {
    throw oauthError(data.error);
  }
  const access = normalizeOptionalString(data.access_token);
  const expires = resolveExpiresAtMsFromDurationSeconds(data.expires_in, { nowMs: now });
  if (
    !access ||
    normalizeOptionalString(data.token_type)?.toLowerCase() !== "bearer" ||
    expires === undefined
  ) {
    throw new Error(
      "Hugging Face OAuth returned no bearer token or valid expires_in. Retry login.",
    );
  }
  const grantedScope = normalizeOptionalString(data.scope);
  if (grantedScope !== undefined && !grantedScope.split(/\s+/).includes(SCOPE)) {
    throw new Error(
      "Hugging Face OAuth did not grant inference-api. Enable it for your OAuth app and log in again.",
    );
  }
  return { access, expires, refresh: normalizeOptionalString(data.refresh_token), grantedScope };
}

async function login(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  assertCurrent(ctx);
  await withOAuthLoginAbort(
    ctx.prompter.note(
      "Use your own Hugging Face public OAuth app (no client secret) with inference-api enabled. " +
        "Find its client ID at https://huggingface.co/settings/applications. An HF access token is not a client ID.",
      "Hugging Face device login",
    ),
    ctx.signal,
  );
  assertCurrent(ctx);
  const clientId = (
    await withOAuthLoginAbort(
      ctx.prompter.text({
        message: "Hugging Face public OAuth client ID",
        signal: ctx.signal,
        validate: (value) =>
          !value.trim() || value.trim().startsWith("hf_")
            ? "Enter a public OAuth client ID, not an access token."
            : undefined,
      }),
      ctx.signal,
    )
  ).trim();
  assertCurrent(ctx);
  const progress = ctx.prompter.progress("Requesting Hugging Face device code…");
  try {
    const started = Date.now();
    const device = await request(
      "device",
      new URLSearchParams({ client_id: clientId, scope: SCOPE }),
      ctx.signal,
    );
    assertCurrent(ctx);
    if (device.error) {
      throw oauthError(device.error);
    }
    const deviceCode = normalizeOptionalString(device.device_code);
    const userCode = normalizeOptionalString(device.user_code);
    const expires = resolveExpiresAtMsFromDurationSeconds(device.expires_in, { nowMs: started });
    const pollInterval = finiteSecondsToTimerSafeMilliseconds(device.interval ?? 5);
    const verificationUri = normalizeOptionalString(device.verification_uri);
    if (
      !deviceCode ||
      !userCode ||
      expires === undefined ||
      pollInterval === undefined ||
      !verificationUri
    ) {
      throw new Error("Hugging Face OAuth returned an invalid device code response. Retry login.");
    }
    const url = new URL(verificationUri);
    if (![ORIGIN, "https://hf.co"].includes(url.origin) || url.username || url.password) {
      throw new Error("Hugging Face OAuth returned an unexpected verification URL.");
    }
    await withOAuthLoginAbort(
      ctx.prompter.note(
        `Open ${url.href} in your browser and enter code: ${userCode}`,
        "Authorize Hugging Face",
      ),
      ctx.signal,
    );
    assertCurrent(ctx);
    if (!ctx.isRemote) {
      try {
        await withOAuthLoginAbort(ctx.openUrl(url.href), ctx.signal);
      } catch {
        assertCurrent(ctx);
        // The displayed URL also works when this machine has no browser.
      }
    }
    progress.update("Waiting for Hugging Face authorization…");
    let interval = pollInterval;
    while (Date.now() < expires) {
      assertCurrent(ctx);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await withOAuthLoginAbort(
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(interval, expires - Date.now()));
          }),
          ctx.signal,
        );
      } finally {
        clearTimeout(timer);
      }
      assertCurrent(ctx);
      if (Date.now() >= expires) {
        break;
      }
      const requestedAt = Date.now();
      const signal = buildOAuthRequestSignal({
        signal: ctx.signal,
        timeoutMs: expires - requestedAt,
      });
      let data: Record<string, unknown>;
      try {
        data = await request(
          "token",
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: clientId,
          }),
          signal,
        );
      } catch (error) {
        assertCurrent(ctx);
        if (Date.now() >= expires) {
          break;
        }
        if (!(error instanceof HuggingfaceOAuthRequestError)) {
          throw error;
        }
        interval = Math.min(interval * 2, MAX_TIMER_TIMEOUT_MS);
        continue;
      }
      assertCurrent(ctx);
      if (data.error === "authorization_pending") {
        continue;
      }
      if (data.error === "slow_down") {
        interval = Math.min(interval + 5_000, MAX_TIMER_TIMEOUT_MS);
        continue;
      }
      if (!data.error && !data.access_token) {
        interval = Math.min(interval * 2, MAX_TIMER_TIMEOUT_MS);
        continue;
      }
      const token = parseToken(data, requestedAt);
      const configPatch = applyHuggingfaceConnectionConfig({});
      progress.stop("Hugging Face credential received");
      if (token.refresh) {
        return buildOauthProviderAuthResult({
          providerId: "huggingface",
          defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
          ...token,
          credentialExtra: {
            clientId,
            authorizationScope: SCOPE,
            ...(token.grantedScope ? { grantedScope: token.grantedScope } : {}),
          },
          configPatch,
          notes: [
            "Hugging Face OAuth tokens refresh automatically. Run login again if access is revoked.",
          ],
        });
      }
      return {
        profiles: [
          {
            profileId: "huggingface:default",
            credential: {
              type: "token",
              provider: "huggingface",
              token: token.access,
              expires: token.expires,
            },
            secretStorage: { kind: "store", namePrefix: "HUGGINGFACE_OAUTH_TOKEN" },
          },
        ],
        defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
        configPatch,
        notes: [
          "Hugging Face did not issue a refresh token. Run login again when this access token expires.",
        ],
      };
    }
    throw oauthError("expired_token");
  } catch (error) {
    progress.stop("Hugging Face login did not complete");
    throw error;
  }
}

export async function refreshHuggingfaceOAuth(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const clientId = normalizeOptionalString(credential.clientId);
  if (!clientId || !normalizeOptionalString(credential.refresh)) {
    throw new Error(
      "Hugging Face OAuth is missing its client ID or refresh token. Run login again.",
    );
  }
  const requestedAt = Date.now();
  const token = parseToken(
    await request(
      "token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: credential.refresh,
      }),
    ),
    requestedAt,
  );
  return {
    ...credential,
    access: token.access,
    refresh: token.refresh ?? credential.refresh,
    expires: token.expires,
    ...(token.grantedScope ? { grantedScope: token.grantedScope } : {}),
  };
}

export function createHuggingfaceOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: "oauth",
    label: "Hugging Face OAuth",
    hint: "Device code (public OAuth app required)",
    kind: "device_code",
    wizard: {
      choiceId: "huggingface-oauth",
      choiceLabel: "Hugging Face OAuth",
      choiceHint: "Device code (public OAuth app required)",
      groupId: "huggingface",
      groupLabel: "Hugging Face",
      groupHint: "OAuth or API key",
      methodId: "oauth",
      onboardingScopes: ["text-inference"],
    },
    run: login,
  };
}
