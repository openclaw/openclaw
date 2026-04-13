import type { M365ResolvedAccountConfig, M365ResolvedPluginConfig } from "./config.js";
import {
  buildM365DelegatedCredentials,
  createM365CredentialStore,
  type M365CredentialStore,
} from "./credentials.js";

export type M365Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type M365GraphAccessToken = {
  accessToken: string;
  expiresAt: number;
  source: "app-only" | "delegated-cache" | "delegated-refresh";
};

export class M365GraphApiError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(message: string, params: { status: number; responseText: string }) {
    super(message);
    this.name = "M365GraphApiError";
    this.status = params.status;
    this.responseText = params.responseText;
  }
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
};

const M365_DELEGATED_REFRESH_SCOPES = [
  "offline_access",
  "Calendars.Read",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.Send",
  "User.Read",
].join(" ");

function requireConfigured(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`${label} required for M365 Graph auth`);
  }
  return value.trim();
}

function normalizeScopes(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const scopes = raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length ? scopes : undefined;
}

async function parseTokenResponse(response: Response, context: string): Promise<TokenResponse> {
  const text = await response.text();
  if (!response.ok) {
    throw new M365GraphApiError(`Microsoft identity token request failed for ${context}`, {
      status: response.status,
      responseText: text,
    });
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Microsoft identity token response was not JSON for ${context}`);
  }
}

function tokenExpiresAtMs(rawExpiresIn: unknown, nowMs: number): number {
  const expiresIn =
    typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? rawExpiresIn
      : 3600;
  return nowMs + Math.max(60, Math.floor(expiresIn) - 60) * 1000;
}

function extractAccessToken(response: TokenResponse, context: string): string {
  if (typeof response.access_token !== "string" || !response.access_token.trim()) {
    throw new Error(`Microsoft identity token response missing access_token for ${context}`);
  }
  return response.access_token.trim();
}

function tokenEndpoint(config: M365ResolvedPluginConfig, tenantId: string): string {
  return `${config.tokenBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
    tenantId,
  )}/oauth2/v2.0/token`;
}

async function requestAppOnlyToken(params: {
  account: M365ResolvedAccountConfig;
  config: M365ResolvedPluginConfig;
  fetchImpl: M365Fetch;
  nowMs: number;
}): Promise<M365GraphAccessToken> {
  const tenantId = requireConfigured(params.account.tenantId, "tenantId");
  const clientId = requireConfigured(params.account.clientId, "clientId");
  const clientSecret = requireConfigured(params.account.clientSecret, "clientSecret");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const response = await params.fetchImpl(tokenEndpoint(params.config, tenantId), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const parsed = await parseTokenResponse(response, params.account.identityId);
  return {
    accessToken: extractAccessToken(parsed, params.account.identityId),
    expiresAt: tokenExpiresAtMs(parsed.expires_in, params.nowMs),
    source: "app-only",
  };
}

async function requestDelegatedRefreshToken(params: {
  account: M365ResolvedAccountConfig;
  config: M365ResolvedPluginConfig;
  fetchImpl: M365Fetch;
  refreshToken: string;
  existingExpiresAt?: number;
  nowMs: number;
  credentialStore: M365CredentialStore;
}): Promise<M365GraphAccessToken> {
  const tenantId = requireConfigured(params.account.tenantId, "tenantId");
  const clientId = requireConfigured(params.account.clientId, "clientId");
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    scope: M365_DELEGATED_REFRESH_SCOPES,
  });
  if (params.account.clientSecret) {
    body.set("client_secret", params.account.clientSecret);
  }
  const response = await params.fetchImpl(tokenEndpoint(params.config, tenantId), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const parsed = await parseTokenResponse(response, params.account.identityId);
  const accessToken = extractAccessToken(parsed, params.account.identityId);
  const expiresAt = tokenExpiresAtMs(parsed.expires_in, params.nowMs);
  const existing = await params.credentialStore.load(params.account.identityId);
  await params.credentialStore.save(
    buildM365DelegatedCredentials({
      identityId: params.account.identityId,
      tenantId,
      clientId,
      accessToken,
      refreshToken:
        typeof parsed.refresh_token === "string" && parsed.refresh_token.trim()
          ? parsed.refresh_token.trim()
          : params.refreshToken,
      expiresAt,
      scopes: normalizeScopes(parsed.scope),
      existing,
      now: new Date(params.nowMs),
    }),
  );
  return {
    accessToken,
    expiresAt,
    source: "delegated-refresh",
  };
}

export async function resolveM365GraphAccessToken(params: {
  account: M365ResolvedAccountConfig;
  config: M365ResolvedPluginConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: M365Fetch;
  nowMs?: number;
  credentialStore?: M365CredentialStore;
}): Promise<M365GraphAccessToken> {
  const fetchImpl = params.fetchImpl ?? ((input, init) => fetch(input, init));
  const nowMs = params.nowMs ?? Date.now();
  if (params.account.authMode === "app-only") {
    return await requestAppOnlyToken({
      account: params.account,
      config: params.config,
      fetchImpl,
      nowMs,
    });
  }

  const credentialStore =
    params.credentialStore ?? createM365CredentialStore({ env: params.env ?? process.env });
  const cached = await credentialStore.load(params.account.identityId);
  if (!cached) {
    throw new Error(
      `No delegated M365 credentials found for identityId "${params.account.identityId}"`,
    );
  }
  if (cached.accessToken && cached.expiresAt - nowMs > 5 * 60 * 1000) {
    return {
      accessToken: cached.accessToken,
      expiresAt: cached.expiresAt,
      source: "delegated-cache",
    };
  }
  if (!cached.refreshToken) {
    throw new Error(
      `Delegated M365 credentials for identityId "${params.account.identityId}" do not include a refresh token`,
    );
  }
  return await requestDelegatedRefreshToken({
    account: params.account,
    config: params.config,
    fetchImpl,
    refreshToken: cached.refreshToken,
    existingExpiresAt: cached.expiresAt,
    nowMs,
    credentialStore,
  });
}

export type M365GraphRequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  expectNoContent?: boolean;
};

export type M365GraphJsonClient = {
  requestJson: <T = unknown>(graphPath: string, options?: M365GraphRequestOptions) => Promise<T>;
};

export class M365GraphClient {
  private readonly config: M365ResolvedPluginConfig;
  private readonly account: M365ResolvedAccountConfig;
  private readonly fetchImpl: M365Fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nowMs: () => number;
  private readonly credentialStore?: M365CredentialStore;
  private cachedToken?: M365GraphAccessToken;

  constructor(params: {
    config: M365ResolvedPluginConfig;
    account: M365ResolvedAccountConfig;
    fetchImpl?: M365Fetch;
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
    credentialStore?: M365CredentialStore;
  }) {
    this.config = params.config;
    this.account = params.account;
    this.fetchImpl = params.fetchImpl ?? ((input, init) => fetch(input, init));
    this.env = params.env ?? process.env;
    this.nowMs = params.nowMs ?? (() => Date.now());
    this.credentialStore = params.credentialStore;
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.nowMs();
    if (this.cachedToken && this.cachedToken.expiresAt - nowMs > 5 * 60 * 1000) {
      return this.cachedToken.accessToken;
    }
    this.cachedToken = await resolveM365GraphAccessToken({
      account: this.account,
      config: this.config,
      env: this.env,
      fetchImpl: this.fetchImpl,
      nowMs,
      credentialStore: this.credentialStore,
    });
    return this.cachedToken.accessToken;
  }

  async requestJson<T = unknown>(
    graphPath: string,
    options: M365GraphRequestOptions = {},
  ): Promise<T> {
    const pathPart = graphPath.startsWith("/") ? graphPath : `/${graphPath}`;
    const url = new URL(`${this.config.graphBaseUrl.replace(/\/+$/, "")}${pathPart}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const token = await this.accessToken();
    const response = await this.fetchImpl(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new M365GraphApiError(`Microsoft Graph request failed (${response.status})`, {
        status: response.status,
        responseText: text,
      });
    }
    if (options.expectNoContent || response.status === 204 || !text.trim()) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Microsoft Graph response was not JSON for ${pathPart}`);
    }
  }
}

export function encodeGraphPathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function graphUrlToPath(graphUrl: string): string {
  const url = new URL(graphUrl);
  const normalizedPathname = url.pathname.replace(/^\/(?:v1\.0|beta)(?=\/)/, "");
  return `${normalizedPathname}${url.search}`;
}
