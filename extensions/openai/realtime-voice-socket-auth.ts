import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-auth.js";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { readRealtimeErrorDetail } from "./realtime-provider-shared.js";
import {
  OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  hasOpenAIRealtimePlatformAuthInputAsync,
  isDirectOpenAIRealtimeWebSocketUrl,
  isOpenAIRealtimeStartupAuthFailure,
  requireOpenAIRealtimePlatformAuth,
  resolveOpenAIRealtimePlatformAuth,
} from "./realtime-voice-session-policy.js";

export type OpenAIRealtimeSocketAuth =
  | { type: "api-key"; token: string }
  | { type: "oauth"; token: string; accountId: string };

type SocketAuthParams = Parameters<typeof resolveOpenAIRealtimePlatformAuth>[0];
type SocketAuthLogger = Pick<PluginLogger, "warn"> & Partial<Pick<PluginLogger, "debug">>;

export const OPENAI_REALTIME_SOCKET_AUTH_REQUIRED =
  "OpenAI Realtime voice requires an OpenAI Platform API key or a ChatGPT sign-in";
export const OPENAI_REALTIME_CHATGPT_SIGN_IN_REJECTED =
  "OpenAI Realtime rejected the ChatGPT sign-in. Sign in again or configure an OpenAI Platform API key";

// OpenAI accepts the socket, then refuses a bad ChatGPT token with a pre-ready error
// event (for example `invalid_jwt`, observed 2026-11-20) or an HTTP 401/403 handshake.
const OPENAI_REALTIME_SUBSCRIPTION_REJECTION_CODES = new Set([
  "invalid_jwt",
  "invalid_api_key",
  "token_expired",
  "token_invalidated",
  "token_revoked",
]);

/** A ChatGPT sign-in that OpenAI refused at socket startup (expired, revoked, or unreadable). */
export function isOpenAIRealtimeSubscriptionRejection(error: unknown): boolean {
  const record = asOptionalObjectRecord(error);
  const status = record?.status ?? record?.statusCode;
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : "";
  return (
    isOpenAIRealtimeStartupAuthFailure(error) ||
    status === 403 ||
    OPENAI_REALTIME_SUBSCRIPTION_REJECTION_CODES.has(code) ||
    readRealtimeErrorDetail(error).toLowerCase().includes("unexpected server response: 403")
  );
}

/** Names the credential OpenAI refused when a direct socket fails before it is ready. */
export function mapOpenAIRealtimeStartupError(
  error: unknown,
  url: string,
  authType: OpenAIRealtimeSocketAuth["type"],
): Error {
  if (isDirectOpenAIRealtimeWebSocketUrl(url)) {
    if (authType === "oauth" && isOpenAIRealtimeSubscriptionRejection(error)) {
      return new Error(OPENAI_REALTIME_CHATGPT_SIGN_IN_REJECTED);
    }
    if (isOpenAIRealtimeStartupAuthFailure(error)) {
      return new Error(OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED);
    }
  }
  return error instanceof Error ? error : new Error(readRealtimeErrorDetail(error));
}

/**
 * Auth for a direct GA socket to api.openai.com when no key is configured on the
 * voice provider itself. The ChatGPT subscription wins, matching the Codex GPT-Live
 * route; the Platform API-key profile and OPENAI_API_KEY are the fallback.
 */
export async function requireOpenAIRealtimeSocketAuth(
  params: SocketAuthParams,
  runtime: OpenAIRealtimeHost,
): Promise<OpenAIRealtimeSocketAuth> {
  const { resolveAgentDir } = runtime;
  const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth(
    {
      cfg: params.cfg,
      agentDir:
        params.cfg && params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined,
    },
    runtime,
  );
  if (subscriptionAuth) {
    return subscriptionAuth;
  }
  const platformAuth = await resolveOpenAIRealtimePlatformAuth(params, runtime);
  if (platformAuth) {
    return { type: "api-key", token: platformAuth };
  }
  throw new Error(
    (await hasOpenAIRealtimePlatformAuthInputAsync(params, runtime))
      ? OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED
      : OPENAI_REALTIME_SOCKET_AUTH_REQUIRED,
  );
}

/** Picks the credential for one connection and logs which one it is. */
export async function resolveOpenAIRealtimeConnectionAuth(params: {
  authParams: SocketAuthParams;
  // ChatGPT OAuth stays on api.openai.com: custom endpoints never receive it.
  customEndpoint: boolean;
  subscriptionRejected: boolean;
  runtime: OpenAIRealtimeHost;
  logger: SocketAuthLogger;
}): Promise<OpenAIRealtimeSocketAuth> {
  const auth: OpenAIRealtimeSocketAuth =
    params.customEndpoint || params.subscriptionRejected
      ? {
          type: "api-key",
          token: await requireOpenAIRealtimePlatformAuth(params.authParams, params.runtime),
        }
      : await requireOpenAIRealtimeSocketAuth(params.authParams, params.runtime);
  const source =
    auth.type === "oauth"
      ? "ChatGPT subscription"
      : params.subscriptionRejected
        ? "Platform API key after the ChatGPT sign-in was rejected"
        : "Platform API key";
  params.logger.debug?.(`OpenAI realtime auth: ${source}`);
  return auth;
}

/** A refused ChatGPT sign-in may retry once with the Platform key before the session starts. */
export async function canRetryRejectedSubscriptionWithKey(
  error: unknown,
  params: {
    authParams: SocketAuthParams;
    runtime: OpenAIRealtimeHost;
    logger: SocketAuthLogger;
  },
): Promise<boolean> {
  if (!(error instanceof Error) || error.message !== OPENAI_REALTIME_CHATGPT_SIGN_IN_REJECTED) {
    return false;
  }
  if (!(await resolveOpenAIRealtimePlatformAuth(params.authParams, params.runtime))) {
    return false;
  }
  params.logger.warn(
    "OpenAI realtime rejected the ChatGPT sign-in; retrying with the OpenAI Platform API key",
  );
  return true;
}
