/** MCP OAuth credential provider, flow coordinator, and login helpers. */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type OpenClawStateAsyncLeaseContext,
  withOpenClawStateLeaseAsync,
} from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { requesterMcpOAuthStoreKeyPrefix, type McpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  createMcpOAuthClientProvider,
  type McpOAuthConfig,
  withMcpOAuthLeaseSignal,
} from "./mcp-oauth-provider.js";
import {
  projectMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "./mcp-oauth-status.js";
import {
  clearMcpOAuthStore,
  consumeOAuthState,
  deleteMcpOAuthPendingAuthorization,
  deleteMcpOAuthPendingAuthorizationsByPrefix,
  listMcpOAuthStoreKeysByPrefix,
  countMcpOAuthStorePrincipals,
  readMcpOAuthStore,
  readMcpOAuthStoreReadOnly,
  readMcpOAuthStoreStatuses,
  mutateMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
  type McpOAuthStore,
} from "./mcp-oauth-store.js";
import type { resolveMcpTransportConfig } from "./mcp-transport-config.js";

export type { McpOAuthPrincipalStatus } from "./mcp-oauth-status.js";
export type { McpOAuthConfig } from "./mcp-oauth-provider.js";

type ResolvedHttpMcpTransportConfig = Extract<
  NonNullable<ReturnType<typeof resolveMcpTransportConfig>>,
  { kind: "http" }
>;

type McpOAuthAuthorizationStartResult =
  | { status: "authorized" }
  | { status: "redirect"; authorizationUrl: string; redirectUrl: string; state: string };

const LOCALHOST_REDIRECT_URL = "http://localhost:8989/oauth/callback";
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const MCP_OAUTH_LEASE_MS = 60_000;
const MCP_OAUTH_LEASE_WAIT_MS = 30_000;

function isMcpOAuthRedirectRegistrationError(error: unknown): boolean {
  return /invalid_client_metadata|redirect_uri/i.test(String(error));
}

async function withMcpOAuthLease<T>(
  storeKey: string,
  run: (lease: OpenClawStateAsyncLeaseContext, context: OpenClawStateWorkerContext) => Promise<T>,
  signal?: AbortSignal,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<T> {
  return await withOpenClawStateLeaseAsync(
    {
      scope: "core:mcp-oauth",
      key: storeKey,
      leaseMs: MCP_OAUTH_LEASE_MS,
      waitMs: MCP_OAUTH_LEASE_WAIT_MS,
      ...(signal ? { signal } : {}),
    },
    context,
    (lease) => run(lease, context),
  );
}

function mcpOAuthAdditionalAuthorizationError(serverName: string): Error {
  return new Error(
    `MCP server "${serverName}" requires additional OAuth authorization. Run openclaw mcp login ${serverName}.`,
  );
}

type ResolveMcpOAuthAccessTokenParams = {
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
  fetchFn?: FetchLike;
  acceptUnknownExpiry?: boolean;
  rejectedAccessToken?: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  allowMissingToken?: boolean;
  authorizationChallenge?: boolean;
  interactiveAuthorizationRequired?: boolean;
  signal?: AbortSignal;
};

/** Returns a current MCP-native OAuth token under one cross-process flow lease. */
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams & { allowMissingToken: true },
): Promise<string | undefined>;
export function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string>;
export async function resolveMcpOAuthAccessToken(
  params: ResolveMcpOAuthAccessTokenParams,
): Promise<string | undefined> {
  const storeKey = params.identity.storeKey;
  return await withMcpOAuthLease(
    storeKey,
    async (lease, context) => {
      const store = await readMcpOAuthStore(storeKey, context);
      const tokens = store.tokens;
      const rejectedCurrentToken = params.rejectedAccessToken === tokens?.access_token;
      const challengeAppliesToCurrentState = !tokens?.access_token || rejectedCurrentToken;
      if (params.authorizationChallenge === true && challengeAppliesToCurrentState) {
        const resourceMetadataUrl = params.resourceMetadataUrl?.toString();
        const scope = normalizeOptionalString(params.scope);
        if (resourceMetadataUrl || scope || params.interactiveAuthorizationRequired === true) {
          await mutateMcpOAuthStore(
            storeKey,
            {
              kind: "authorizationChallenge",
              resourceMetadataUrl,
              scope,
              ...(params.interactiveAuthorizationRequired === true
                ? { requiresAuthorization: true }
                : {}),
            },
            lease,
            context,
          );
        }
      }
      if (
        params.authorizationChallenge === true &&
        params.interactiveAuthorizationRequired === true &&
        challengeAppliesToCurrentState
      ) {
        throw mcpOAuthAdditionalAuthorizationError(params.identity.serverName);
      }
      if (store.pendingAuthorizationChallenge?.requiresAuthorization === true) {
        throw mcpOAuthAdditionalAuthorizationError(params.identity.serverName);
      }
      if (!tokens?.access_token) {
        if (params.allowMissingToken === true) {
          return undefined;
        }
        throw new Error(
          `MCP server "${params.identity.serverName}" requires OAuth authorization. Run openclaw mcp login ${params.identity.serverName}.`,
        );
      }

      const tokenIsFresh =
        store.tokenExpiresAt !== undefined &&
        store.tokenExpiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
      if (
        !rejectedCurrentToken &&
        (tokenIsFresh ||
          (store.tokenExpiresAt === undefined &&
            (params.acceptUnknownExpiry === true || !tokens.refresh_token)))
      ) {
        return tokens.access_token;
      }
      if (!tokens.refresh_token) {
        throw new Error(
          `MCP server "${params.identity.serverName}" has expired OAuth credentials. Run openclaw mcp login ${params.identity.serverName}.`,
        );
      }

      const pendingChallenge = store.pendingAuthorizationChallenge;
      await mutateMcpOAuthStore(storeKey, { kind: "bindTokensIssuer" }, lease, context);
      const provider = await createMcpOAuthClientProvider({
        identity: params.identity,
        config: params.config,
        lease,
        storeContext: context,
      });
      const result = await auth(provider, {
        serverUrl: params.identity.serverUrl,
        resourceMetadataUrl:
          params.resourceMetadataUrl ??
          (pendingChallenge?.resourceMetadataUrl
            ? new URL(pendingChallenge.resourceMetadataUrl)
            : undefined),
        scope:
          params.scope ??
          normalizeOptionalString(pendingChallenge?.scope) ??
          normalizeOptionalString(params.config?.scope),
        fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
      });
      await lease.assertOwned();
      const refreshedTokens = await provider.tokens();
      if (result !== "AUTHORIZED" || !refreshedTokens?.access_token) {
        throw new Error(
          `MCP server "${params.identity.serverName}" could not refresh OAuth credentials. Run openclaw mcp login ${params.identity.serverName}.`,
        );
      }
      return refreshedTokens.access_token;
    },
    params.signal,
  );
}

/** Persist a terminal resource rejection without overwriting newer credentials. */
export async function recordMcpOAuthAuthorizationRequired(params: {
  identity: McpOAuthIdentity;
  rejectedAccessToken: string;
  resourceMetadataUrl?: URL;
  scope?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const storeKey = params.identity.storeKey;
  return await withMcpOAuthLease(
    storeKey,
    async (lease, context) => {
      const store = await readMcpOAuthStore(storeKey, context);
      if (store.tokens?.access_token !== params.rejectedAccessToken) {
        return false;
      }
      const { applied } = await mutateMcpOAuthStore(
        storeKey,
        {
          kind: "authorizationChallenge",
          rejectedAccessToken: params.rejectedAccessToken,
          resourceMetadataUrl: params.resourceMetadataUrl?.toString(),
          scope: normalizeOptionalString(params.scope),
          requiresAuthorization: true,
        },
        lease,
        context,
      );
      return applied;
    },
    params.signal,
  );
}

/** Deletes one OAuth session without racing an in-flight refresh or login. */
export async function clearMcpOAuthCredentials(identity: McpOAuthIdentity): Promise<void> {
  await clearMcpOAuthStoreKey(identity.storeKey);
}

async function clearMcpOAuthStoreKey(
  storeKey: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<void> {
  await withMcpOAuthLease(
    storeKey,
    async (lease) => {
      await clearMcpOAuthStore(storeKey, lease, context);
    },
    undefined,
    context,
  );
}

/** Clear operator and requester credentials bound to one configured server URL. */
export async function clearMcpOAuthServer(identity: McpOAuthIdentity): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  await clearMcpOAuthStoreKey(identity.storeKey, context);
  await clearMcpOAuthRequesters(identity, context);
}

/** Clear requester credentials without changing the operator row for this server URL. */
export async function clearMcpOAuthRequesters(
  identity: McpOAuthIdentity,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<void> {
  const prefix = requesterMcpOAuthStoreKeyPrefix(identity.serverName, identity.serverUrl);
  const requesterKeys = await listMcpOAuthStoreKeysByPrefix(prefix, context);
  for (const storeKey of requesterKeys) {
    await clearMcpOAuthStoreKey(storeKey, context);
  }
  await deleteMcpOAuthPendingAuthorizationsByPrefix(prefix, context);
}

/** Count authorized requester principals for one configured server URL. */
export async function countMcpOAuthPrincipals(identity: McpOAuthIdentity): Promise<number> {
  return countMcpOAuthStorePrincipals(
    requesterMcpOAuthStoreKeyPrefix(identity.serverName, identity.serverUrl),
  );
}

/** Read one ordered requester set within a single current storage lifetime. */
export async function readMcpOAuthCredentialsStatuses(
  identities: readonly McpOAuthIdentity[],
): Promise<McpOAuthPrincipalStatus[]> {
  return readMcpOAuthStoreStatuses(identities.map((identity) => identity.storeKey));
}

/** Reads stored OAuth credential presence without exposing values or creating state. */
export async function readMcpOAuthCredentialsStatus(
  identity: McpOAuthIdentity,
  preparedStore?: McpOAuthStore,
): Promise<McpOAuthPrincipalStatus> {
  const store = preparedStore ?? (await readMcpOAuthStoreReadOnly(identity.storeKey));
  return projectMcpOAuthCredentialsStatus(store);
}

function buildMcpOAuthAuthorizationFetch(config: ResolvedHttpMcpTransportConfig): FetchLike {
  const fetchFn = buildMcpHttpFetch({
    sslVerify: config.sslVerify,
    clientCert: config.clientCert,
    clientKey: config.clientKey,
    resourceUrl: config.url,
    timeoutMs: config.requestTimeoutMs,
  });
  return withSameOriginMcpHttpHeaders({
    fetchFn,
    headers: withoutMcpAuthorizationHeader(config.headers),
    resourceUrl: config.url,
  });
}

async function runMcpOAuthAuthorizationAttempt(
  params: {
    identity: McpOAuthIdentity;
    config: McpOAuthConfig;
    fetchFn: FetchLike;
    authorizationCode?: string;
    resourceMetadataUrl?: URL;
    scope?: string;
    suppressStoredTokens?: boolean;
  },
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<"authorized" | "redirect"> {
  const provider = await createMcpOAuthClientProvider({
    identity: params.identity,
    config: params.config,
    allowAuthorizationRedirect: true,
    suppressStoredTokens: params.suppressStoredTokens,
    lease,
    storeContext: context,
  });
  const result = await auth(provider, {
    serverUrl: params.identity.serverUrl,
    authorizationCode: normalizeOptionalString(params.authorizationCode),
    resourceMetadataUrl: params.resourceMetadataUrl,
    scope: normalizeOptionalString(params.scope) ?? normalizeOptionalString(params.config?.scope),
    fetchFn: withMcpOAuthLeaseSignal(params.fetchFn, lease.signal),
  });
  await lease.assertOwned();
  return result === "AUTHORIZED" ? "authorized" : "redirect";
}

export async function startMcpOAuthAuthorization(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  opts: { redirectUrl?: string },
): Promise<McpOAuthAuthorizationStartResult> {
  const storeKey = identity.storeKey;
  return await withMcpOAuthLease(storeKey, async (lease, context) => {
    const store = await readMcpOAuthStore(storeKey, context);
    const pendingChallenge = store.pendingAuthorizationChallenge;
    const configuredRedirectUrl =
      normalizeOptionalString(opts.redirectUrl) ??
      normalizeOptionalString(config.oauth?.redirectUrl) ??
      store.redirectUrl;
    const oauthConfig: McpOAuthConfig = {
      ...config.oauth,
      ...(configuredRedirectUrl ? { redirectUrl: configuredRedirectUrl } : {}),
    };
    const attempt = {
      identity,
      config: oauthConfig,
      fetchFn: buildMcpOAuthAuthorizationFetch(config),
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      suppressStoredTokens: pendingChallenge?.requiresAuthorization === true,
    };
    let result: "authorized" | "redirect";
    try {
      result = await runMcpOAuthAuthorizationAttempt(attempt, lease, context);
    } catch (error) {
      if (
        !normalizeOptionalString(opts.redirectUrl) &&
        !normalizeOptionalString(config.oauth?.redirectUrl) &&
        isMcpOAuthRedirectRegistrationError(error)
      ) {
        result = await runMcpOAuthAuthorizationAttempt(
          {
            ...attempt,
            config: { ...config.oauth, redirectUrl: LOCALHOST_REDIRECT_URL },
          },
          lease,
          context,
        );
      } else {
        throw error;
      }
    }
    if (result === "authorized") {
      return { status: "authorized" };
    }
    const pending = await readMcpOAuthStore(storeKey, context);
    const authorizationUrl = pending.lastAuthorizationUrl;
    const state = authorizationUrl ? new URL(authorizationUrl).searchParams.get("state") : null;
    if (!authorizationUrl || !pending.codeVerifier || !pending.redirectUrl || !state) {
      throw new Error("MCP OAuth authorization session was not persisted.");
    }
    await writeMcpOAuthPendingAuthorization(storeKey, state, lease, context);
    return { status: "redirect", authorizationUrl, redirectUrl: pending.redirectUrl, state };
  });
}

export async function completeMcpOAuthAuthorization(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string },
): Promise<"authorized"> {
  const storeKey = identity.storeKey;
  return await withMcpOAuthLease<"authorized">(storeKey, async (lease, context) => {
    return await completeMcpOAuthAuthorizationUnderLease(identity, config, input, lease, context);
  });
}

function readMcpOAuthAuthorizationState(authorizationUrl: string | undefined): string | undefined {
  if (!authorizationUrl) {
    return undefined;
  }
  try {
    return normalizeOptionalString(new URL(authorizationUrl).searchParams.get("state"));
  } catch {
    return undefined;
  }
}

async function completeMcpOAuthAuthorizationUnderLease(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string },
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<"authorized"> {
  const storeKey = identity.storeKey;
  const store = await readMcpOAuthStore(storeKey, context);
  if (!store.codeVerifier || !store.redirectUrl) {
    throw new Error("Missing MCP OAuth authorization session. Run the login flow again.");
  }
  const pendingChallenge = store.pendingAuthorizationChallenge;
  await runMcpOAuthAuthorizationAttempt(
    {
      identity,
      config: { ...config.oauth, redirectUrl: store.redirectUrl },
      fetchFn: buildMcpOAuthAuthorizationFetch(config),
      authorizationCode: input.code,
      resourceMetadataUrl: pendingChallenge?.resourceMetadataUrl
        ? new URL(pendingChallenge.resourceMetadataUrl)
        : undefined,
      scope: normalizeOptionalString(pendingChallenge?.scope),
      suppressStoredTokens: pendingChallenge?.requiresAuthorization === true,
    },
    lease,
    context,
  );
  await mutateMcpOAuthStore(storeKey, { kind: "completeAuthorization" }, lease, context);
  await deleteMcpOAuthPendingAuthorization(storeKey, lease, context);
  return "authorized";
}

/** Claims one callback state and completes its exchange under the same store lease. */
export async function completeOAuthCallback(
  identity: McpOAuthIdentity,
  config: ResolvedHttpMcpTransportConfig,
  input: { code: string; state: string },
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<"authorized" | "expired"> {
  return await withMcpOAuthLease(
    identity.storeKey,
    async (lease) => {
      if (!(await consumeOAuthState(identity.storeKey, input.state, lease, context))) {
        return "expired";
      }
      const store = await readMcpOAuthStore(identity.storeKey, context);
      if (readMcpOAuthAuthorizationState(store.lastAuthorizationUrl) !== input.state) {
        return "expired";
      }
      return await completeMcpOAuthAuthorizationUnderLease(identity, config, input, lease, context);
    },
    undefined,
    context,
  );
}
