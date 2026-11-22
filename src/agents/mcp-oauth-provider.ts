/** MCP SDK OAuth provider backed by canonical OpenClaw state. */
import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthTokens,
  FetchLike,
} from "@modelcontextprotocol/client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { coerceSecretRef } from "../config/types.secrets.js";
import { MCP_OAUTH_AUTHORIZATION_PARAM_KEYS } from "../config/zod-schema.mcp-server.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import type { McpOAuthRefreshBoundary } from "./mcp-oauth-refresh-boundary.js";
import { isMcpOAuthStoreBoundToClient } from "./mcp-oauth-status.js";
import { mcpOAuthAuthorizationRequiredError } from "./mcp-oauth-store.authorization.js";
import { readMcpOAuthStore, mutateMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";
import { MCP_OAUTH_DEFAULT_REDIRECT_URL } from "./mcp-oauth-store.mutations.js";
import type { McpOAuthMutation } from "./mcp-oauth-store.types.js";

export type McpOAuthConfig = {
  scope?: unknown;
  redirectUrl?: unknown;
  clientMetadataUrl?: unknown;
  /** Pre-registered client; `clientSecret` must already be resolved to a string. */
  clientId?: unknown;
  clientSecret?: unknown;
  authorizationParams?: unknown;
};

/** An operator-fixable OAuth client setting; its message names config paths, never secrets. */
export class McpOAuthClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthClientConfigError";
  }
}

/** The pre-registered client this config requires stored credentials to belong to, if any. */
export function configuredMcpOAuthClientId(config: McpOAuthConfig | undefined): string | undefined {
  return normalizeOptionalString(config?.clientId);
}

/** Whether stored credentials belong to the configured pre-registered client, if any. */
export function isMcpOAuthStoreBoundToConfiguredClient(
  store: McpOAuthStore,
  config: McpOAuthConfig | undefined,
): boolean {
  return isMcpOAuthStoreBoundToClient(store, configuredMcpOAuthClientId(config));
}

function resolveConfiguredClient(
  serverName: string,
  config: McpOAuthConfig,
): { client_id: string; client_secret?: string } | undefined {
  const clientId = normalizeOptionalString(config.clientId);
  if (!clientId) {
    return undefined;
  }
  const secret = config.clientSecret;
  if (secret === undefined) {
    return { client_id: clientId };
  }
  if (typeof secret === "string" && secret.length > 0) {
    return { client_id: clientId, client_secret: secret };
  }
  const ref = coerceSecretRef(secret);
  const path = `${appendConfigPathSegment("mcp.servers", serverName)}.oauth.clientSecret`;
  throw new McpOAuthClientConfigError(
    `MCP server "${serverName}": ${path}${ref ? ` (${secretRefKey(ref)})` : ""} is not resolved. ` +
      "Make the secret available, then run openclaw secrets reload or restart the Gateway.",
  );
}

export type McpOAuthLoginLifecycle = {
  signal: AbortSignal;
  assertCurrent: () => void;
  onAuthorizationPublished: (state: string) => void;
  beforeTokensSaved: () => void;
  onTokensSaved: () => void;
};

export class McpOAuthCredentialsRetainedError extends Error {
  constructor() {
    super("Existing authentication was retained. Use the CLI sign-in flow.");
    this.name = "McpOAuthCredentialsRetainedError";
  }
}

function resolveTokenExpiresAt(tokens: OAuthTokens): number | undefined {
  const expiresIn = tokens.expires_in;
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

function canReuseStoredTokens(store: McpOAuthStore): boolean {
  const discoveredIssuer = store.discoveryState?.authorizationServerUrl;
  return (
    !store.tokens?.refresh_token ||
    discoveredIssuer === undefined ||
    (store.tokensAuthorizationServerUrl !== undefined &&
      discoveredIssuer === store.tokensAuthorizationServerUrl)
  );
}

function resolveOAuthRedirectUrl(config: McpOAuthConfig, store: McpOAuthStore = {}): string {
  return (
    normalizeOptionalString(config.redirectUrl) ??
    normalizeOptionalString(store.redirectUrl) ??
    MCP_OAUTH_DEFAULT_REDIRECT_URL
  );
}

/** Whether a dynamically registered client accepts this redirect (RFC 8252 loopback ports). */
export function hasRegisteredOAuthRedirect(redirectUris: string[], redirectUrl: string): boolean {
  if (redirectUris.includes(redirectUrl)) {
    return true;
  }
  const loopback = URL.parse(redirectUrl);
  if (
    !loopback ||
    loopback.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(loopback.hostname)
  ) {
    return false;
  }
  // RFC 8252 exempts the port, not other callback bytes changed by URL serialization.
  return redirectUris.includes(redirectUrl.replace(/^(http:\/\/[^/?#]+):\d+(?=[/?#]|$)/iu, "$1"));
}

/** Bind OAuth network work to the lease that fences its persisted side effects. */
export function withMcpOAuthLeaseSignal(
  fetchFn: FetchLike | undefined,
  leaseSignal: AbortSignal,
  assertCurrent?: () => void,
): FetchLike {
  const baseFetch: FetchLike = fetchFn ?? ((url, init) => fetch(url, init));
  return async (url, init) => {
    assertCurrent?.();
    const requestSignal = init?.signal;
    const signal = requestSignal ? AbortSignal.any([requestSignal, leaseSignal]) : leaseSignal;
    const response = await baseFetch(url, { ...init, signal });
    assertCurrent?.();
    return response;
  };
}

/** Creates the MCP SDK OAuth provider backed by canonical shared SQLite state. */
export async function createMcpOAuthClientProvider(params: {
  identity: McpOAuthIdentity;
  config?: McpOAuthConfig;
  allowAuthorizationRedirect?: boolean;
  suppressStoredTokens?: boolean;
  replaceAuthorization?: boolean;
  lease: OpenClawStateAsyncLeaseContext;
  login?: McpOAuthLoginLifecycle;
  storeContext: OpenClawStateWorkerContext;
  refreshBoundary?: McpOAuthRefreshBoundary;
}): Promise<OAuthClientProvider> {
  const config = params.config ?? {};
  const configuredClient = resolveConfiguredClient(params.identity.serverName, config);
  const storeKey = params.identity.storeKey;
  const storeContext = params.storeContext;
  let preparedVerifier: string | undefined;
  let prepared: { redirectUrl?: string } | { error: unknown } = {};
  const readStore = async () => {
    params.login?.assertCurrent();
    const store = await readMcpOAuthStore(storeKey, storeContext);
    params.login?.assertCurrent();
    await params.lease.assertOwned();
    params.login?.assertCurrent();
    prepared = { redirectUrl: store.redirectUrl };
    return store;
  };
  await readStore();
  params.login?.assertCurrent();
  const updateStore = async (
    mutation: McpOAuthMutation,
    options: { beforeCommit?: () => void; onAcknowledged?: () => void } = {},
  ) => {
    params.login?.assertCurrent();
    const authority = params.login
      ? { assertCurrent: params.login.assertCurrent, beforeCommit: options.beforeCommit }
      : undefined;
    try {
      const { store } = await mutateMcpOAuthStore(
        { storeKey, lease: params.lease, context: storeContext },
        mutation,
        authority,
      );
      // Record acknowledged persistence before a later authority loss can reject publication.
      options.onAcknowledged?.();
      params.login?.assertCurrent();
      prepared = { redirectUrl: store.redirectUrl };
      return store;
    } catch (error) {
      // Failed writes leave metadata unavailable until a new read is acknowledged.
      prepared = { error };
      throw error;
    }
  };
  const preparedStore = () => {
    if ("error" in prepared) {
      throw prepared.error;
    }
    return prepared;
  };
  const assertAuthorizationRedirectAllowed = () => {
    params.login?.assertCurrent();
    if (params.allowAuthorizationRedirect !== true) {
      throw mcpOAuthAuthorizationRequiredError(params.identity, storeContext.admission);
    }
  };
  return {
    get redirectUrl() {
      return resolveOAuthRedirectUrl(config, preparedStore());
    },
    clientMetadataUrl: configuredClient
      ? undefined
      : normalizeOptionalString(config.clientMetadataUrl),
    get clientMetadata(): OAuthClientMetadata {
      const redirectUrl = resolveOAuthRedirectUrl(config, preparedStore());
      const scope = normalizeOptionalString(config.scope);
      return {
        client_name: "OpenClaw MCP",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(scope ? { scope } : {}),
      };
    },
    async state() {
      assertAuthorizationRedirectAllowed();
      if (params.login) {
        const store = await readStore();
        params.login.assertCurrent();
        if (
          store.tokens?.access_token &&
          // Only an earlier attempt's fenced claim makes these tokens unusable; this attempt's own
          // failed refresh still reports instead of starting authorization.
          (!store.refreshClaim || store.refreshClaim === params.refreshBoundary?.claim) &&
          store.pendingAuthorizationChallenge?.requiresAuthorization !== true &&
          (store.tokenExpiresAt === undefined || store.tokenExpiresAt > Date.now())
        ) {
          throw new Error(
            "Existing authentication could not be refreshed. Use the CLI sign-in flow.",
          );
        }
      }
      // State validates one browser round trip. It is not reusable persisted state.
      return randomUUID();
    },
    async clientInformation(ctx) {
      const store = await readStore();
      params.login?.assertCurrent();
      // The SDK can replace a mismatched client before requesting authorization.
      // Background refresh must preserve the original registration and tokens;
      // only an explicit login may start registration with another issuer.
      if (!canReuseStoredTokens(store)) {
        assertAuthorizationRedirectAllowed();
      }
      const clientInformation = store.clientInformation;
      // A configured client is never registered. Its stored row only binds the issuer.
      if (configuredClient) {
        // Only a matching stamp is returned; otherwise the SDK stamps the current issuer.
        const issuer =
          clientInformation?.client_id === configuredClient.client_id &&
          clientInformation.issuer === ctx?.issuer
            ? clientInformation.issuer
            : undefined;
        return issuer === undefined ? { ...configuredClient } : { ...configuredClient, issuer };
      }
      // Re-register an unused client when the callback changes. Saved tokens remain
      // bound to their original client; metadata-document clients have no redirect list.
      if (
        !store.tokens &&
        clientInformation &&
        "redirect_uris" in clientInformation &&
        Array.isArray(clientInformation.redirect_uris) &&
        !hasRegisteredOAuthRedirect(
          clientInformation.redirect_uris,
          resolveOAuthRedirectUrl(config, store),
        )
      ) {
        return undefined;
      }
      return clientInformation;
    },
    async saveClientInformation(clientInformation) {
      if (configuredClient) {
        // The SDK writes back what clientInformation() returned; the secret stays in config.
        const { client_secret: _secret, ...binding } = clientInformation;
        const store = await readStore();
        if (store.tokens && store.clientInformation?.client_id !== binding.client_id) {
          // Tokens issued to another client must never become usable under this one.
          await updateStore({ kind: "invalidate", scope: "tokens", suppressStoredTokens: false });
        }
        await updateStore({ kind: "clientInformation", clientInformation: binding });
        params.login?.assertCurrent();
        return;
      }
      await updateStore({ kind: "clientInformation", clientInformation });
      params.login?.assertCurrent();
    },
    async tokens() {
      if (params.suppressStoredTokens) {
        params.login?.assertCurrent();
        await params.lease.assertOwned();
        params.login?.assertCurrent();
        return undefined;
      }
      const store = await readStore();
      params.login?.assertCurrent();
      if (store.refreshClaim && store.refreshClaim !== params.refreshBoundary?.claim) {
        if (params.allowAuthorizationRedirect) {
          return undefined;
        }
        throw new Error("MCP OAuth refresh outcome is uncertain; sign in again.");
      }
      return canReuseStoredTokens(store) && isMcpOAuthStoreBoundToConfiguredClient(store, config)
        ? store.tokens
        : undefined;
    },
    async saveTokens(tokens) {
      params.refreshBoundary?.assertTokens(tokens);
      await updateStore(
        {
          kind: "tokens",
          tokens,
          tokenExpiresAt: resolveTokenExpiresAt(tokens),
          ...(params.replaceAuthorization ? { replaceAuthorization: true } : {}),
          ...(params.refreshBoundary?.claim ? { refreshClaim: params.refreshBoundary.claim } : {}),
        },
        {
          beforeCommit: params.login?.beforeTokensSaved,
          onAcknowledged: params.login?.onTokensSaved,
        },
      );
      params.login?.assertCurrent();
    },
    async redirectToAuthorization(authorizationUrl) {
      assertAuthorizationRedirectAllowed();
      const state = authorizationUrl.searchParams.get("state");
      if (params.login && (!state || !preparedVerifier)) {
        throw new Error("MCP OAuth authorization preparation is incomplete.");
      }
      const extraParams = isRecord(config.authorizationParams) ? config.authorizationParams : {};
      for (const key of MCP_OAUTH_AUTHORIZATION_PARAM_KEYS) {
        const value = normalizeOptionalString(extraParams[key]);
        if (value) {
          authorizationUrl.searchParams.set(key, value);
        }
      }
      await updateStore(
        {
          kind: "authorizationRedirect",
          authorizationUrl: authorizationUrl.toString(),
          redirectUrl: normalizeOptionalString(config.redirectUrl),
          codeVerifier: preparedVerifier,
        },
        {
          onAcknowledged: () => {
            preparedVerifier = undefined;
            if (state) {
              params.login?.onAuthorizationPublished(state);
            }
          },
        },
      );
      params.login?.assertCurrent();
    },
    saveCodeVerifier(codeVerifier) {
      assertAuthorizationRedirectAllowed();
      preparedVerifier = codeVerifier;
    },
    async codeVerifier() {
      params.login?.assertCurrent();
      let codeVerifier = preparedVerifier;
      if (codeVerifier !== undefined) {
        await params.lease.assertOwned();
        params.login?.assertCurrent();
      } else {
        const store = await readStore();
        params.login?.assertCurrent();
        codeVerifier = store.codeVerifier;
      }
      if (!codeVerifier) {
        throw new Error("Missing MCP OAuth code verifier. Run the login flow again.");
      }
      return codeVerifier;
    },
    async invalidateCredentials(scope) {
      params.login?.assertCurrent();
      params.refreshBoundary?.assertCanInvalidate();
      if (params.login) {
        throw new McpOAuthCredentialsRetainedError();
      }
      await updateStore({
        kind: "invalidate",
        scope,
        suppressStoredTokens: params.suppressStoredTokens === true,
      });
    },
    async saveDiscoveryState(discoveryState) {
      await updateStore({ kind: "discoveryState", discoveryState });
      params.login?.assertCurrent();
    },
    async discoveryState() {
      const store = await readStore();
      params.login?.assertCurrent();
      return store.discoveryState;
    },
  };
}
