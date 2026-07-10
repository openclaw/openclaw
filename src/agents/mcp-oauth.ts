/**
 * MCP OAuth credential store and login helpers. Credentials are stored in the
 * private OpenClaw state directory with one hashed file per MCP server URL.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

type McpOAuthStore = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  redirectUrl?: string;
  state?: string;
};

type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

/** Persisted OAuth credential presence flags for one MCP server. */
export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

const LEGACY_DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";
const LOCALHOST_REDIRECT_URL = "http://localhost:8989/oauth/callback";
const REFRESH_REQUEST_TIMEOUT_MS = 90_000;
const REFRESH_LOCK_TIMEOUT_MS = REFRESH_REQUEST_TIMEOUT_MS + 30_000;
const REFRESH_LOCK_STALE_MS = REFRESH_LOCK_TIMEOUT_MS + 30_000;
const REFRESH_LOCK_POLL_MS = 100;

function isMcpOAuthRedirectRegistrationError(error: unknown): boolean {
  return /invalid_client_metadata|redirect_uri/i.test(String(error));
}

function oauthStorePath(serverName: string, serverUrl: string): string {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const key = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return path.join(resolveStateDir(), "mcp-oauth", `${safeServerName}-${key.slice(0, 16)}.json`);
}

async function readStore(filePath: string): Promise<McpOAuthStore> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

function readStoreSync(filePath: string): McpOAuthStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

async function writeStore(filePath: string, store: McpOAuthStore): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fsPromises.writeFile(tempPath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fsPromises.chmod(tempPath, 0o600).catch(() => {});
  await fsPromises.rename(tempPath, filePath);
  await fsPromises.chmod(filePath, 0o600).catch(() => {});
}

async function updateStore(
  filePath: string,
  update: (store: McpOAuthStore) => McpOAuthStore,
): Promise<void> {
  const lock = await acquireStoreLock(filePath);
  try {
    await writeStore(filePath, update(await readStore(filePath)));
  } finally {
    await lock.release();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type StoreLock = {
  release: () => Promise<void>;
};

async function acquireStoreLock(filePath: string): Promise<StoreLock> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const lockId = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            id: lockId,
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          const current = await readStore(lockPath);
          if ((current as { id?: string }).id === lockId) {
            await fsPromises.rm(lockPath, { force: true }).catch(() => {});
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      const stat = await fsPromises.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
        await fsPromises.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > REFRESH_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for MCP OAuth token refresh lock for ${path.basename(filePath)}.`,
          { cause: error },
        );
      }
      await sleep(REFRESH_LOCK_POLL_MS);
    }
  }
}

function refreshTokenFromRequestBody(body: BodyInit | null | undefined): string | null {
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token" ? body.get("refresh_token") : null;
  }
  if (typeof body === "string") {
    const params = new URLSearchParams(body);
    return params.get("grant_type") === "refresh_token" ? params.get("refresh_token") : null;
  }
  return null;
}

function responseFromTokens(tokens: OAuthTokens): Response {
  return new Response(JSON.stringify(tokens), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function parseRefreshResponseTokens(
  response: Response,
  refreshToken: string,
): Promise<OAuthTokens> {
  return OAuthTokensSchema.parse({
    refresh_token: refreshToken,
    ...(await response.clone().json()),
  });
}

async function fetchRefreshTokenWithDeadline(
  fetchFn: FetchLike,
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1] | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
    throw new Error("MCP OAuth token refresh was aborted.");
  }

  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Timed out refreshing MCP OAuth tokens."));
    }, REFRESH_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      fetchFn(input, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    LEGACY_DEFAULT_REDIRECT_URL
  );
}

function buildOAuthClientMetadata(
  config: McpOAuthConfig,
  store: McpOAuthStore = {},
): OAuthClientMetadata {
  const redirectUrl = resolveOAuthRedirectUrl(config, store);
  return {
    client_name: "OpenClaw MCP",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(normalizeOptionalString(config.scope)
      ? { scope: normalizeOptionalString(config.scope) }
      : {}),
  };
}

type OAuthClientProviderWithRefreshSerialization = OAuthClientProvider & {
  wrapFetchForTokenRefresh(fetchFn?: FetchLike): FetchLike;
};

/** Creates the MCP SDK OAuth provider backed by OpenClaw's private store. */
export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
}): OAuthClientProviderWithRefreshSerialization {
  const config = params.config ?? {};
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const allowAuthorizationRedirect =
    params.allowAuthorizationRedirect ?? Boolean(params.onAuthorizationUrl);
  const assertAuthorizationRedirectAllowed = () => {
    if (!allowAuthorizationRedirect) {
      throw new Error(
        `MCP server "${params.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.serverName}.`,
      );
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, readStoreSync(filePath));
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config, readStoreSync(filePath));
    },
    async state() {
      assertAuthorizationRedirectAllowed();
      const state = randomUUID();
      await updateStore(filePath, (store) => ({ ...store, state }));
      return state;
    },
    async clientInformation() {
      return (await readStore(filePath)).clientInformation;
    },
    async saveClientInformation(clientInformation) {
      await updateStore(filePath, (store) => ({ ...store, clientInformation }));
    },
    async tokens() {
      return (await readStore(filePath)).tokens;
    },
    async saveTokens(tokens) {
      await updateStore(filePath, (store) => ({ ...store, tokens }));
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      await updateStore(filePath, (store) => ({
        ...store,
        lastAuthorizationUrl: authorizationUrl.toString(),
      }));
      await params.onAuthorizationUrl?.(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      await updateStore(filePath, (store) => ({ ...store, codeVerifier }));
    },
    async codeVerifier() {
      const codeVerifier = (await readStore(filePath)).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      await updateStore(filePath, (store) => {
        const next: McpOAuthStore = { ...store };
        if (scope === "all" || scope === "client") {
          delete next.clientInformation;
        }
        if (scope === "all" || scope === "tokens") {
          delete next.tokens;
        }
        if (scope === "all" || scope === "verifier") {
          delete next.codeVerifier;
        }
        if (scope === "all" || scope === "discovery") {
          delete next.discoveryState;
        }
        return next;
      });
    },
    async saveDiscoveryState(discoveryState) {
      await updateStore(filePath, (store) => ({ ...store, discoveryState }));
    },
    async discoveryState() {
      return (await readStore(filePath)).discoveryState;
    },
    wrapFetchForTokenRefresh(fetchFn) {
      return async (input, init) => {
        const refreshToken = refreshTokenFromRequestBody(init?.body);
        if (!refreshToken) {
          return await (fetchFn ?? fetch)(input, init);
        }

        const lock = await acquireStoreLock(filePath);
        try {
          const store = await readStore(filePath);
          const currentTokens = store.tokens;
          if (
            currentTokens?.refresh_token &&
            currentTokens.refresh_token !== refreshToken &&
            currentTokens.access_token
          ) {
            return responseFromTokens(currentTokens);
          }

          const response = await fetchRefreshTokenWithDeadline(fetchFn ?? fetch, input, init);
          if (!response.ok) {
            return response;
          }

          // The MCP SDK refresh path parses the same response and calls saveTokens().
          // Persisting the clone before releasing the lock lets concurrent callers
          // observe the rotated refresh token instead of replaying the stale one.
          const tokens = await parseRefreshResponseTokens(response, refreshToken);
          const latestStore = await readStore(filePath);
          await writeStore(filePath, { ...latestStore, tokens });
          return response;
        } finally {
          await lock.release();
        }
      };
    },
  };
}

/** Deletes stored OAuth credentials for one MCP server. */
export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  await fsPromises.rm(oauthStorePath(params.serverName, params.serverUrl), { force: true });
}

/** Reads stored OAuth credential presence without exposing credential values. */
export async function readMcpOAuthCredentialsStatus(params: {
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthCredentialsStatus> {
  const store = await readStore(oauthStorePath(params.serverName, params.serverUrl));
  return {
    hasTokens: Boolean(store.tokens),
    hasClientInformation: Boolean(store.clientInformation),
    hasCodeVerifier: Boolean(store.codeVerifier),
    hasDiscoveryState: Boolean(store.discoveryState),
    hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
  };
}

async function runMcpOAuthLoginAttempt(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const provider = createMcpOAuthClientProvider({
    ...params,
    allowAuthorizationRedirect: true,
  });
  const result = await auth(provider, {
    serverUrl: params.serverUrl,
    authorizationCode: normalizeOptionalString(params.authorizationCode),
    scope: normalizeOptionalString(params.config?.scope),
    fetchFn: provider.wrapFetchForTokenRefresh(params.fetchFn),
  });
  return result === "AUTHORIZED" ? "authorized" : "redirect";
}

/** Runs the MCP OAuth login flow, returning whether it authorized or needs redirect. */
export async function runMcpOAuthLogin(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  authorizationCode?: string;
  fetchFn?: FetchLike;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}): Promise<"authorized" | "redirect"> {
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const store = await readStore(filePath);
  const loginParams = {
    ...params,
    config: {
      ...params.config,
      redirectUrl: normalizeOptionalString(params.config?.redirectUrl) ?? store.redirectUrl,
    },
  };
  try {
    return await runMcpOAuthLoginAttempt(loginParams);
  } catch (error) {
    if (
      !normalizeOptionalString(params.authorizationCode) &&
      !normalizeOptionalString(params.config?.redirectUrl) &&
      isMcpOAuthRedirectRegistrationError(error)
    ) {
      const result = await runMcpOAuthLoginAttempt({
        ...params,
        config: {
          ...params.config,
          redirectUrl: LOCALHOST_REDIRECT_URL,
        },
      });
      await updateStore(filePath, (latestStore) => ({
        ...latestStore,
        redirectUrl: LOCALHOST_REDIRECT_URL,
      }));
      return result;
    }
    throw error;
  }
}
