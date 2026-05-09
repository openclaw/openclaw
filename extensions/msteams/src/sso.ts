/**
 * Bot Framework OAuth SSO invoke handlers for Microsoft Teams.
 *
 * Handles two invoke activities Teams sends when the bot has presented
 * an `oauthCard` or when the user completes an interactive sign-in:
 *
 * 1. `signin/tokenExchange`
 *    The Teams client obtained an exchangeable token from the bot's
 *    AAD app and forwards it to the bot. The bot exchanges that token
 *    with the Bot Framework User Token service, which returns the real
 *    delegated user token (for example, a Microsoft Graph access token
 *    if the OAuth connection is set up for Graph).
 *
 * 2. `signin/verifyState`
 *    Fallback for the magic-code flow: the user finishes sign-in in a
 *    browser tab, receives a 6-digit code, and pastes it back into the
 *    chat. The bot then asks the User Token service for the token
 *    corresponding to that code.
 *
 * In both cases the bot must reply with an `invokeResponse` (HTTP 200)
 * immediately or the Teams UI shows "Something went wrong". Callers of
 * {@link handleSigninTokenExchangeInvoke} and
 * {@link handleSigninVerifyStateInvoke} are responsible for sending
 * that ack; these helpers encapsulate token exchange and persistence.
 */

import { Buffer } from "node:buffer";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsSsoTokenStore } from "./sso-token-store.js";
import { buildUserAgent } from "./user-agent.js";

/** Scope used to obtain a Bot Framework service token. */
const BOT_FRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";

/** Bot Framework User Token service base URL. */
const BOT_FRAMEWORK_USER_TOKEN_BASE_URL = "https://token.botframework.com";
const BOT_FRAMEWORK_SIGN_IN_BASE_URL = BOT_FRAMEWORK_USER_TOKEN_BASE_URL;

/**
 * Response shape returned by the Bot Framework User Token service for
 * `GetUserToken` and `ExchangeToken`.
 *
 * @see https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-user-token-service
 */
type BotFrameworkUserTokenResponse = {
  channelId?: string;
  connectionName: string;
  token: string;
  expiration?: string;
};

export type MSTeamsSsoFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type MSTeamsSsoDeps = {
  tokenProvider: MSTeamsAccessTokenProvider;
  tokenStore: MSTeamsSsoTokenStore;
  connectionName: string;
  /** Override `fetch` for testing. */
  fetchImpl?: MSTeamsSsoFetch;
  /** Override the User Token service base URL (testing / sovereign clouds). */
  userTokenBaseUrl?: string;
  /** Override the Bot Framework sign-in base URL (testing / sovereign clouds). */
  signInBaseUrl?: string;
};

export type MSTeamsSsoUser = {
  /** Stable user identifier — AAD object ID when available. */
  userId: string;
  /** Bot Framework channel ID (default: "msteams"). */
  channelId?: string;
};

export type MSTeamsSsoResult =
  | {
      ok: true;
      token: string;
      expiresAt?: string;
    }
  | {
      ok: false;
      code:
        | "missing_user"
        | "missing_connection"
        | "missing_consent"
        | "missing_token"
        | "missing_state"
        | "service_error"
        | "unexpected_response";
      message: string;
      status?: number;
    };

type SigninTokenExchangeValue = {
  id?: string;
  connectionName?: string;
  token?: string;
};

type SigninVerifyStateValue = {
  state?: string;
};

export type MSTeamsSsoSignInResource = {
  signInLink: string;
  tokenExchangeResource?: {
    id?: string;
    uri?: string;
    providerId?: string;
  };
};

export type MSTeamsSsoSignInResourceResult =
  | ({ ok: true } & MSTeamsSsoSignInResource)
  | {
      ok: false;
      code: "missing_connection" | "missing_app" | "service_error" | "unexpected_response";
      message: string;
      status?: number;
    };

/**
 * Extract and validate the `signin/tokenExchange` activity value. Teams
 * delivers `{ id, connectionName, token }`; any field may be missing on
 * malformed invocations, so callers should check the parsed result.
 */
export function parseSigninTokenExchangeValue(value: unknown): SigninTokenExchangeValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const connectionName = typeof obj.connectionName === "string" ? obj.connectionName : undefined;
  const token = typeof obj.token === "string" ? obj.token : undefined;
  return { id, connectionName, token };
}

/** Extract the `signin/verifyState` activity value `{ state }`. */
export function parseSigninVerifyStateValue(value: unknown): SigninVerifyStateValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const state = typeof obj.state === "string" ? obj.state : undefined;
  return { state };
}

type UserTokenServiceCallParams = {
  baseUrl: string;
  path: string;
  query: Record<string, string>;
  method: "GET" | "POST";
  body?: unknown;
  bearerToken: string;
  fetchImpl: MSTeamsSsoFetch;
};

function buildServiceErrorResult(message: string): Extract<MSTeamsSsoResult, { ok: false }> {
  return { ok: false, code: "service_error", message };
}

function buildUnexpectedResponseResult(
  message: string,
  status?: number,
): Extract<MSTeamsSsoResult, { ok: false }> {
  return {
    ok: false,
    code: "unexpected_response",
    message,
    ...(status !== undefined ? { status } : {}),
  };
}

async function getBotFrameworkBearerToken(
  deps: MSTeamsSsoDeps,
): Promise<
  { ok: true; token: string } | { ok: false; result: Extract<MSTeamsSsoResult, { ok: false }> }
> {
  try {
    return {
      ok: true,
      token: await deps.tokenProvider.getAccessToken(BOT_FRAMEWORK_TOKEN_SCOPE),
    };
  } catch {
    return {
      ok: false,
      result: buildServiceErrorResult("Bot Framework token acquisition failed"),
    };
  }
}

async function callUserTokenService(
  params: UserTokenServiceCallParams,
): Promise<BotFrameworkUserTokenResponse | { error: string; status: number }> {
  const qs = new URLSearchParams(params.query).toString();
  const url = `${params.baseUrl.replace(/\/+$/, "")}${params.path}?${qs}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${params.bearerToken}`,
    "User-Agent": buildUserAgent(),
  };
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await params.fetchImpl(url, {
    method: params.method,
    headers,
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { error: text || `HTTP ${response.status}`, status: response.status };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { error: "invalid JSON from User Token service", status: response.status };
  }
  if (!parsed || typeof parsed !== "object") {
    return { error: "empty response from User Token service", status: response.status };
  }
  const obj = parsed as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token : undefined;
  const connectionName = typeof obj.connectionName === "string" ? obj.connectionName : undefined;
  const channelId = typeof obj.channelId === "string" ? obj.channelId : undefined;
  const expiration = typeof obj.expiration === "string" ? obj.expiration : undefined;
  if (!token || !connectionName) {
    return { error: "User Token service response missing token/connectionName", status: 502 };
  }
  return { channelId, connectionName, token, expiration };
}

async function callUserTokenServiceSafely(
  params: UserTokenServiceCallParams,
): Promise<BotFrameworkUserTokenResponse | { error: string; status: number }> {
  try {
    return await callUserTokenService(params);
  } catch {
    return { error: "User Token service request failed", status: 503 };
  }
}

function validateUserTokenConnectionName(
  response: BotFrameworkUserTokenResponse,
  expectedConnectionName: string,
): Extract<MSTeamsSsoResult, { ok: false }> | null {
  if (response.connectionName === expectedConnectionName) {
    return null;
  }
  return buildUnexpectedResponseResult(
    "User Token service returned token for an unexpected OAuth connection",
    502,
  );
}

function createTokenExchangeState(params: {
  appId: string;
  connectionName: string;
  activity: MSTeamsTurnContext["activity"];
}): string {
  const { activity } = params;
  // Match botframework-connector UserTokenClient.createTokenExchangeState.
  // The JS SDK uses these lowercase keys for the opaque GetSignInResource state.
  const state = {
    connectionName: params.connectionName,
    conversation: {
      activityId: activity.id,
      user: activity.from,
      bot: activity.recipient,
      conversation: activity.conversation,
      channelId: activity.channelId,
      locale: activity.locale,
      serviceUrl: activity.serviceUrl,
    },
    relatesTo: activity.relatesTo,
    msAppId: params.appId,
  };
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

function normalizeTokenExchangeResource(
  value: unknown,
): MSTeamsSsoSignInResource["tokenExchangeResource"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const uri = typeof obj.uri === "string" ? obj.uri : undefined;
  const providerId = typeof obj.providerId === "string" ? obj.providerId : undefined;
  if (!id && !uri && !providerId) {
    return undefined;
  }
  return {
    ...(id ? { id } : {}),
    ...(uri ? { uri } : {}),
    ...(providerId ? { providerId } : {}),
  };
}

export async function getMSTeamsSsoSignInResource(params: {
  activity: MSTeamsTurnContext["activity"];
  appId: string;
  connectionName: string;
  deps: MSTeamsSsoDeps;
  finalRedirect?: string;
}): Promise<MSTeamsSsoSignInResourceResult> {
  const connectionName = params.connectionName.trim();
  if (!connectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }
  const appId = params.appId.trim();
  if (!appId) {
    return { ok: false, code: "missing_app", message: "no bot app id" };
  }

  const bearer = await getBotFrameworkBearerToken(params.deps);
  if (!bearer.ok) {
    return {
      ok: false,
      code: "service_error",
      message: bearer.result.message,
      status: bearer.result.status,
    };
  }

  const state = createTokenExchangeState({
    appId,
    connectionName,
    activity: params.activity,
  });
  const qs = new URLSearchParams({
    state,
    ...(params.finalRedirect ? { finalRedirect: params.finalRedirect } : {}),
  }).toString();
  const url = `${(params.deps.signInBaseUrl ?? BOT_FRAMEWORK_SIGN_IN_BASE_URL).replace(
    /\/+$/,
    "",
  )}/api/botsignin/GetSignInResource?${qs}`;
  const fetchImpl = params.deps.fetchImpl ?? (globalThis.fetch as unknown as MSTeamsSsoFetch);

  let response: Awaited<ReturnType<MSTeamsSsoFetch>>;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer.token}`,
        "User-Agent": buildUserAgent(),
      },
    });
  } catch {
    return { ok: false, code: "service_error", message: "Sign-in resource request failed" };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      code: response.status >= 500 ? "service_error" : "unexpected_response",
      message: text || `HTTP ${response.status}`,
      status: response.status,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      code: "unexpected_response",
      message: "invalid JSON from sign-in resource service",
      status: response.status,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      code: "unexpected_response",
      message: "empty sign-in resource response",
      status: response.status,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const signInLink = typeof obj.signInLink === "string" ? obj.signInLink : undefined;
  if (!signInLink) {
    return {
      ok: false,
      code: "unexpected_response",
      message: "sign-in resource response missing signInLink",
      status: response.status,
    };
  }
  return {
    ok: true,
    signInLink,
    tokenExchangeResource: normalizeTokenExchangeResource(obj.tokenExchangeResource),
  };
}

export async function getMSTeamsSsoUserToken(params: {
  user: MSTeamsSsoUser;
  connectionName: string;
  deps: MSTeamsSsoDeps;
  code?: string;
}): Promise<MSTeamsSsoResult> {
  const { user, connectionName, deps, code } = params;
  if (!user.userId) {
    return { ok: false, code: "missing_user", message: "no user id on activity" };
  }
  const expectedConnectionName = connectionName.trim();
  if (!expectedConnectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }

  const bearer = await getBotFrameworkBearerToken(deps);
  if (!bearer.ok) {
    return bearer.result;
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as MSTeamsSsoFetch);
  const result = await callUserTokenServiceSafely({
    baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
    path: "/api/usertoken/GetToken",
    query: {
      userId: user.userId,
      connectionName: expectedConnectionName,
      channelId: user.channelId ?? "msteams",
      ...(code ? { code } : {}),
    },
    method: "GET",
    bearerToken: bearer.token,
    fetchImpl,
  });

  if ("error" in result) {
    const code =
      result.status === 400 || result.status === 404 || result.status === 412
        ? "missing_consent"
        : result.status >= 500
          ? "service_error"
          : "unexpected_response";
    return {
      ok: false,
      code,
      message: result.error,
      status: result.status,
    };
  }

  const connectionMismatch = validateUserTokenConnectionName(result, expectedConnectionName);
  if (connectionMismatch) {
    return connectionMismatch;
  }

  return { ok: true, token: result.token, expiresAt: result.expiration };
}

/**
 * Exchange a Teams SSO token for a delegated user token via Bot
 * Framework's User Token service, then persist the result.
 */
export async function handleSigninTokenExchangeInvoke(params: {
  value: SigninTokenExchangeValue;
  user: MSTeamsSsoUser;
  deps: MSTeamsSsoDeps;
}): Promise<MSTeamsSsoResult> {
  const { value, user, deps } = params;
  if (!user.userId) {
    return { ok: false, code: "missing_user", message: "no user id on invoke activity" };
  }
  const connectionName = deps.connectionName.trim();
  if (!connectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }
  const invokeConnectionName = value.connectionName?.trim();
  if (invokeConnectionName && invokeConnectionName !== connectionName) {
    return buildUnexpectedResponseResult("signin/tokenExchange OAuth connection mismatch");
  }
  if (!value.token) {
    return { ok: false, code: "missing_token", message: "no exchangeable token on invoke" };
  }

  const bearer = await getBotFrameworkBearerToken(deps);
  if (!bearer.ok) {
    return bearer.result;
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as MSTeamsSsoFetch);
  const result = await callUserTokenServiceSafely({
    baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
    path: "/api/usertoken/exchange",
    query: {
      userId: user.userId,
      connectionName,
      channelId: user.channelId ?? "msteams",
    },
    method: "POST",
    body: { token: value.token },
    bearerToken: bearer.token,
    fetchImpl,
  });

  if ("error" in result) {
    return {
      ok: false,
      code: result.status >= 500 ? "service_error" : "unexpected_response",
      message: result.error,
      status: result.status,
    };
  }

  const connectionMismatch = validateUserTokenConnectionName(result, connectionName);
  if (connectionMismatch) {
    return connectionMismatch;
  }

  await deps.tokenStore.save({
    connectionName,
    userId: user.userId,
    token: result.token,
    expiresAt: result.expiration,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, token: result.token, expiresAt: result.expiration };
}

/**
 * Finish a magic-code sign-in: look up the user token for the state
 * code via Bot Framework's User Token service, then persist it.
 */
export async function handleSigninVerifyStateInvoke(params: {
  value: SigninVerifyStateValue;
  user: MSTeamsSsoUser;
  deps: MSTeamsSsoDeps;
}): Promise<MSTeamsSsoResult> {
  const { value, user, deps } = params;
  if (!user.userId) {
    return { ok: false, code: "missing_user", message: "no user id on invoke activity" };
  }
  const connectionName = deps.connectionName.trim();
  if (!connectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }
  const state = value.state?.trim();
  if (!state) {
    return { ok: false, code: "missing_state", message: "no state code on invoke" };
  }

  const result = await getMSTeamsSsoUserToken({
    user,
    connectionName,
    deps,
    code: state,
  });
  if (!result.ok) {
    return result;
  }

  await deps.tokenStore.save({
    connectionName,
    userId: user.userId,
    token: result.token,
    expiresAt: result.expiresAt,
    updatedAt: new Date().toISOString(),
  });

  return result;
}
