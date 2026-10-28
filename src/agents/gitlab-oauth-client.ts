import { createHash, randomBytes } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readResponseWithLimit } from "../infra/http-body.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
} from "../shared/oauth-refresh-outcome.js";
import { validateGitLabOAuthConfig, type GitLabOAuthConfig } from "./gitlab-host.js";

export type { GitLabOAuthConfig } from "./gitlab-host.js";

export type GitLabOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scopes: string[];
};

export type GitLabAccount = {
  accountId: number;
  login: string;
  name: string;
  commitEmail: string;
  issuer: string;
};

type RequestOptions = {
  assertCurrent?: () => void | Promise<void>;
  signal?: AbortSignal;
  beforeDispatch?: () => void;
};

const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 16 * 1024;
const TOKEN_MAX_CHARS = 4096;
const REQUIRED_SCOPES = ["api", "write_repository"] as const;

function invalid(surface: string): Error {
  return new Error(`GitLab ${surface} response was invalid.`);
}

function boundedString(value: unknown, surface: string, maxChars: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maxChars ||
    value.trim() !== value ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalid(surface);
  }
  return value;
}

function parseJson(bytes: Buffer, surface: string): Record<string, unknown> {
  try {
    const record = asOptionalRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (record) {
      return record;
    }
  } catch {
    // Provider bodies and parsing errors can contain credentials.
  }
  throw invalid(surface);
}

function boundedScopes(value: unknown): string[] {
  const values =
    typeof value === "string" && value.length <= 2048
      ? value.split(/[\s,]+/u).filter(Boolean)
      : Array.isArray(value) && value.length <= 32
        ? value
        : undefined;
  if (
    !values ||
    values.some((scope) => typeof scope !== "string" || !/^[a-z_]{1,64}$/u.test(scope))
  ) {
    throw invalid("token info");
  }
  const scopes = [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
  if (!REQUIRED_SCOPES.every((scope) => scopes.includes(scope))) {
    throw new Error("GitLab authorization lacks required scopes.");
  }
  return scopes;
}

async function requestJson(
  url: string,
  init: RequestInit,
  surface: string,
  options: RequestOptions,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  await options.assertCurrent?.();
  signal.throwIfAborted();
  options.beforeDispatch?.();
  const response = await fetch(url, { ...init, redirect: "error", signal });
  await options.assertCurrent?.();
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error(`GitLab ${surface} redirect was refused.`);
  }
  const body = parseJson(
    await readResponseWithLimit(response, RESPONSE_MAX_BYTES, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      chunkTimeoutMs: REQUEST_TIMEOUT_MS,
      signal,
    }),
    surface,
  );
  await options.assertCurrent?.();
  return { response, body };
}

async function readTokenScopes(
  config: GitLabOAuthConfig,
  accessToken: string,
  options: RequestOptions,
): Promise<string[]> {
  const { response, body } = await requestJson(
    `${config.issuer}/oauth/token/info`,
    {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    },
    "token info",
    options,
  );
  if (!response.ok) {
    throw new Error(`GitLab token info request failed (HTTP ${response.status}).`);
  }
  return boundedScopes(body.scope);
}

function parseTokens(body: Record<string, unknown>): Omit<GitLabOAuthTokens, "scopes"> {
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
    throw invalid("token");
  }
  const accessToken = boundedString(body.access_token, "token", TOKEN_MAX_CHARS);
  const refreshToken = boundedString(body.refresh_token, "token", TOKEN_MAX_CHARS);
  registerSecretValueForRedaction(accessToken);
  registerSecretValueForRedaction(refreshToken);
  const duration = body.expires_in;
  if (
    typeof duration !== "number" ||
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > 366 * 86400
  ) {
    throw invalid("token");
  }
  const expiresAtMs = Date.now() + duration * 1000;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw invalid("token");
  }
  return { accessToken, refreshToken, expiresAtMs };
}

export function createGitLabAuthorization(config: GitLabOAuthConfig): {
  state: string;
  verifier: string;
  url: string;
} {
  const selected = validateGitLabOAuthConfig(config);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${selected.issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: selected.clientId,
    redirect_uri: selected.redirectUri,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { state, verifier, url: url.toString() };
}

export async function exchangeGitLabAuthorization(
  config: GitLabOAuthConfig,
  params: { code: string; verifier: string } & RequestOptions,
): Promise<GitLabOAuthTokens> {
  const selected = validateGitLabOAuthConfig(config);
  const code = boundedString(params.code, "authorization code", TOKEN_MAX_CHARS);
  const verifier = boundedString(params.verifier, "PKCE verifier", 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) {
    throw new Error("GitLab PKCE verifier is invalid.");
  }
  try {
    const { response, body } = await requestJson(
      `${selected.issuer}/oauth/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: selected.clientId,
          code,
          code_verifier: verifier,
          redirect_uri: selected.redirectUri,
        }),
      },
      "token exchange",
      params,
    );
    if (!response.ok || body.error !== undefined) {
      throw new Error(`GitLab token exchange failed (HTTP ${response.status}).`);
    }
    const tokens = parseTokens(body);
    return { ...tokens, scopes: await readTokenScopes(selected, tokens.accessToken, params) };
  } catch {
    throw new Error("GitLab authorization failed; start a new sign-in.");
  }
}

export async function refreshGitLabAuthorization(
  config: GitLabOAuthConfig,
  params: { refreshToken: string } & RequestOptions,
): Promise<GitLabOAuthTokens> {
  const selected = validateGitLabOAuthConfig(config);
  const refreshToken = boundedString(params.refreshToken, "refresh token", TOKEN_MAX_CHARS);
  registerSecretValueForRedaction(refreshToken);
  let phase: "before-dispatch" | "token-response" | "after-token-response" = "before-dispatch";
  try {
    await params.assertCurrent?.();
    params.signal?.throwIfAborted();
    const { response, body } = await requestJson(
      `${selected.issuer}/oauth/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: selected.clientId,
          refresh_token: refreshToken,
        }),
      },
      "token refresh",
      {
        ...params,
        beforeDispatch: () => {
          phase = "token-response";
        },
      },
    );
    if (!response.ok || body.error !== undefined) {
      throw createOAuthRefreshResponseError("GitLab OAuth token refresh", response.status, body);
    }
    phase = "after-token-response";
    const tokens = parseTokens(body);
    return { ...tokens, scopes: await readTokenScopes(selected, tokens.accessToken, params) };
  } catch (error) {
    if (asOptionalRecord(error)?.oauthRefreshOutcome) {
      throw error;
    }
    throw createOAuthRefreshError(
      "GitLab OAuth token refresh failed",
      phase === "before-dispatch"
        ? {
            version: 1,
            phase,
            outcome: "not-attempted",
            recovery: { kind: "later", evidence: "dispatch-not-started" },
          }
        : { version: 1, phase, outcome: "unknown" },
    );
  }
}

export async function verifyGitLabAccount(
  config: GitLabOAuthConfig,
  tokens: GitLabOAuthTokens,
  options: RequestOptions & { allowBot?: boolean } = {},
): Promise<GitLabAccount> {
  const selected = validateGitLabOAuthConfig(config);
  const accessToken = boundedString(tokens.accessToken, "access token", TOKEN_MAX_CHARS);
  registerSecretValueForRedaction(accessToken);
  try {
    await readTokenScopes(selected, accessToken, options);
    const { response, body } = await requestJson(
      `${selected.issuer}/api/v4/user`,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      },
      "account",
      options,
    );
    if (!response.ok || (body.bot === true && !options.allowBot)) {
      throw invalid("account");
    }
    const accountId = body.id;
    if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
      throw invalid("account");
    }
    const login = boundedString(body.username, "account", 255);
    const name = boundedString(body.name, "account", 255);
    const commitEmail = boundedString(body.commit_email, "account", 320);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(commitEmail)) {
      throw invalid("account");
    }
    return { accountId, login, name, commitEmail, issuer: selected.issuer };
  } catch {
    throw new Error("GitLab account could not be verified.");
  }
}
