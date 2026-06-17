import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

type McpOAuthStore = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OpenClawOAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  state?: string;
  lastOAuthError?: McpOAuthStoreError;
};

type OpenClawOAuthTokens = OAuthTokens & {
  obtained_at?: number;
  expires_at?: number;
};

type McpOAuthStoreError = {
  code: string;
  message: string;
  updatedAt: string;
};

type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
};

export type McpOAuthCredentialsStatus = {
  hasTokens: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
  tokenExpiresAt?: number;
  lastErrorCode?: string;
  requiresReauthorization?: boolean;
};

const DEFAULT_REDIRECT_URL = "http://127.0.0.1:8989/oauth/callback";
const REFRESH_LOCK_TIMEOUT_MS = 60_000;
const REFRESH_LOCK_STALE_MS = 120_000;
const REFRESH_LOCK_POLL_MS = 100;

function oauthStorePath(serverName: string, serverUrl: string): string {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const key = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return path.join(resolveStateDir(), "mcp-oauth", `${safeServerName}-${key.slice(0, 16)}.json`);
}

async function readStore(filePath: string): Promise<McpOAuthStore> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as McpOAuthStore;
  } catch {
    return {};
  }
}

async function writeStore(filePath: string, store: McpOAuthStore): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(tempPath, 0o600).catch(() => {});
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function withTokenTimestamps(tokens: OAuthTokens): OpenClawOAuthTokens {
  const obtainedAt = Math.floor(Date.now() / 1000);
  const next: OpenClawOAuthTokens = { ...tokens, obtained_at: obtainedAt };
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
    next.expires_at = obtainedAt + Math.max(0, Math.floor(tokens.expires_in));
  }
  return next;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type StoreLock = {
  release: () => Promise<void>;
};

async function acquireStoreLock(filePath: string): Promise<StoreLock> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const started = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          filePath,
        }),
        "utf-8",
      );
      await handle.close();
      let released = false;
      return {
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          await fs.rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > REFRESH_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for MCP OAuth token refresh lock for ${path.basename(filePath)}.`,
        );
      }
      await sleep(REFRESH_LOCK_POLL_MS);
    }
  }
}

function refreshTokenFromRequestBody(body: unknown): string | null {
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token" ? body.get("refresh_token") : null;
  }
  if (typeof body === "string") {
    const params = new URLSearchParams(body);
    return params.get("grant_type") === "refresh_token" ? params.get("refresh_token") : null;
  }
  return null;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildOAuthClientMetadata(config: McpOAuthConfig): OAuthClientMetadata {
  const redirectUrl = normalizeOptionalString(config.redirectUrl) ?? DEFAULT_REDIRECT_URL;
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

export function createMcpOAuthClientProvider(params: {
  serverName: string;
  serverUrl: string;
  config?: McpOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  allowAuthorizationRedirect?: boolean;
}): OAuthClientProvider & { wrapFetchForTokenRefresh: (fetchFn?: FetchLike) => FetchLike } {
  const config = params.config ?? {};
  const filePath = oauthStorePath(params.serverName, params.serverUrl);
  const redirectUrl = normalizeOptionalString(config.redirectUrl) ?? DEFAULT_REDIRECT_URL;
  let refreshLock: StoreLock | null = null;
  const releaseRefreshLock = async () => {
    const lock = refreshLock;
    refreshLock = null;
    await lock?.release();
  };
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
      return redirectUrl;
    },
    clientMetadataUrl: normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata() {
      return buildOAuthClientMetadata(config);
    },
    async state() {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      const state = randomUUID();
      await writeStore(filePath, { ...store, state });
      return state;
    },
    async clientInformation() {
      return (await readStore(filePath)).clientInformation;
    },
    async saveClientInformation(clientInformation) {
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, clientInformation });
    },
    async tokens() {
      return (await readStore(filePath)).tokens;
    },
    async saveTokens(tokens) {
      const store = await readStore(filePath);
      const next: McpOAuthStore = { ...store, tokens: withTokenTimestamps(tokens) };
      delete next.lastOAuthError;
      await writeStore(filePath, next);
      await releaseRefreshLock();
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, lastAuthorizationUrl: authorizationUrl.toString() });
      await params.onAuthorizationUrl?.(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, codeVerifier });
    },
    async codeVerifier() {
      const codeVerifier = (await readStore(filePath)).codeVerifier;
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      const store = await readStore(filePath);
      const next: McpOAuthStore = { ...store };
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
      }
      if (scope === "all" || scope === "tokens") {
        delete next.tokens;
      }
      if (scope === "tokens") {
        next.lastOAuthError = {
          code: "invalid_grant",
          message: "OAuth token refresh failed; reauthorization is required.",
          updatedAt: new Date().toISOString(),
        };
      }
      if (scope === "all" || scope === "verifier") {
        delete next.codeVerifier;
      }
      if (scope === "all" || scope === "discovery") {
        delete next.discoveryState;
      }
      await writeStore(filePath, next);
      await releaseRefreshLock();
    },
    async saveDiscoveryState(discoveryState) {
      const store = await readStore(filePath);
      await writeStore(filePath, { ...store, discoveryState });
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
        refreshLock = await acquireStoreLock(filePath);
        const store = await readStore(filePath);
        const currentRefreshToken = store.tokens?.refresh_token;
        if (
          currentRefreshToken &&
          currentRefreshToken !== refreshToken &&
          store.tokens?.access_token
        ) {
          await releaseRefreshLock();
          return jsonResponse(store.tokens);
        }
        try {
          const response = await (fetchFn ?? fetch)(input, init);
          if (!response.ok) {
            await releaseRefreshLock();
          }
          return response;
        } catch (error) {
          await releaseRefreshLock();
          throw error;
        }
      };
    },
  };
}

export async function clearMcpOAuthCredentials(params: {
  serverName: string;
  serverUrl: string;
}): Promise<void> {
  await fs.rm(oauthStorePath(params.serverName, params.serverUrl), { force: true });
}

export async function readMcpOAuthCredentialsStatus(params: {
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthCredentialsStatus> {
  const store = await readStore(oauthStorePath(params.serverName, params.serverUrl));
  const lastError = store.lastOAuthError;
  return {
    hasTokens: Boolean(store.tokens),
    hasClientInformation: Boolean(store.clientInformation),
    hasCodeVerifier: Boolean(store.codeVerifier),
    hasDiscoveryState: Boolean(store.discoveryState),
    hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
    ...(store.tokens?.expires_at ? { tokenExpiresAt: store.tokens.expires_at } : {}),
    ...(lastError?.code ? { lastErrorCode: lastError.code } : {}),
    requiresReauthorization: lastError?.code === "invalid_grant" || !store.tokens,
  };
}

export async function runMcpOAuthLogin(params: {
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
