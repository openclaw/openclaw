import { auth, extractWWWAuthenticateParams, type FetchLike } from "@modelcontextprotocol/client";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import {
  createMcpEnterpriseProvider,
  mcpEnterpriseIdpIdentity,
  readMcpEnterpriseAuthorizationId,
  type McpEnterpriseConfig,
} from "./mcp-enterprise.js";
import { captureMcpOAuthAuthorization } from "./mcp-oauth-authorization.js";

async function requestInit(request: Request): Promise<RequestInit> {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  };
}

async function captureEnterpriseAuthorization(config: McpEnterpriseConfig) {
  const params = { identity: mcpEnterpriseIdpIdentity(config), assertCurrent() {} };
  try {
    return await captureMcpOAuthAuthorization(params);
  } catch (error) {
    // Concurrent first reads can both observe an empty live owner. One publishes
    // the same canonical grant and invalidates the other's read revision.
    if (
      !(error instanceof McpConnectionAuthorityError) ||
      error.code !== "MCP_AUTHORIZATION_UNAVAILABLE"
    ) {
      throw error;
    }
    return await captureMcpOAuthAuthorization(params);
  }
}

/** Keep resource tokens bound to one server and one transport instance. */
export function withMcpEnterpriseBearer(params: {
  resourceUrl: string;
  config: McpEnterpriseConfig;
  /** Unauthenticated foreign-origin requests still use the guarded transport fetch. */
  fetchFn: FetchLike;
  /** Build final-effect guards bound to the credential incarnation for this request. */
  createAuthenticatedFetches: (assertCurrent: () => void) => {
    resourceFetch: FetchLike;
    authFetch: FetchLike;
  };
}): FetchLike {
  const resourceOrigin = new URL(params.resourceUrl).origin;
  let cached: { authorizationId: string; token: string; expiresAt: number } | undefined;
  type ResourceAuthorization = { authorizationId: string; token: string; expiresAt: number };
  const authorizations = new Map<string, Promise<ResourceAuthorization>>();
  const assertAuthorization = async (authorizationId: string) => {
    if ((await readMcpEnterpriseAuthorizationId(params.config)) !== authorizationId) {
      throw new Error("Enterprise SSO changed during MCP authorization. Retry the request.");
    }
  };
  const authorize = async (
    authorizationId: string,
    authFetchFn: FetchLike,
    challenge?: ReturnType<typeof extractWWWAuthenticateParams>,
  ): Promise<string> => {
    const grantedScopes = new Set(params.config.scope.split(/\s+/).filter(Boolean));
    const requestedScopes = challenge?.scope?.split(/\s+/).filter(Boolean);
    if (requestedScopes?.some((scope) => !grantedScopes.has(scope))) {
      throw new Error("Enterprise MCP server requested a scope outside the configured grant.");
    }
    const scope = requestedScopes?.join(" ") || params.config.scope;
    const key = JSON.stringify([authorizationId, scope]);
    let pending = authorizations.get(key);
    if (!pending) {
      pending = (async () => {
        // Each step of SDK discovery, ID-JAG exchange, and resource redemption
        // must retain the login that began this authorization.
        const authFetch: FetchLike = async (input, init) => {
          await assertAuthorization(authorizationId);
          const response = await authFetchFn(input, init);
          try {
            await assertAuthorization(authorizationId);
          } catch (error) {
            await response.body?.cancel().catch(() => undefined);
            throw error;
          }
          return response;
        };
        const provider = createMcpEnterpriseProvider(params.config, authFetch);
        const result = await auth(provider, {
          serverUrl: params.resourceUrl,
          scope,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          fetchFn: authFetch,
        });
        const tokens = provider.tokens();
        if (result !== "AUTHORIZED" || !tokens?.access_token) {
          throw new Error("Enterprise MCP authorization did not return an access token.");
        }
        await assertAuthorization(authorizationId);
        return {
          authorizationId,
          token: tokens.access_token,
          expiresAt: Date.now() + Math.max(0, (tokens.expires_in ?? 300) - 30) * 1000,
        };
      })();
      authorizations.set(key, pending);
    }
    try {
      const result = await pending;
      if (result.authorizationId !== authorizationId) {
        throw new Error("Enterprise SSO changed during MCP authorization. Retry the request.");
      }
      cached = result;
      return result.token;
    } finally {
      if (authorizations.get(key) === pending) {
        authorizations.delete(key);
      }
    }
  };
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    if (new URL(request.url).origin !== resourceOrigin) {
      return params.fetchFn(request.url, await requestInit(request));
    }
    const authority = await captureEnterpriseAuthorization(params.config);
    try {
      const { resourceFetch, authFetch } = params.createAuthenticatedFetches(
        authority.assertCurrent,
      );
      authority.assertCurrent();
      const authorizationId = authority.authorizationId;
      if (cached?.authorizationId !== authorizationId) {
        cached = undefined;
      }
      const original = await requestInit(request);
      const token = cached && cached.expiresAt > Date.now() ? cached.token : undefined;
      const firstHeaders = new Headers(original.headers);
      if (token) {
        firstHeaders.set("authorization", `Bearer ${token}`);
      }
      const response = await resourceFetch(request.url, { ...original, headers: firstHeaders });
      if (response.status !== 401 && response.status !== 403) {
        return response;
      }
      const challenge = extractWWWAuthenticateParams(response);
      if (response.status === 403 && challenge.error !== "insufficient_scope") {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      cached = undefined;
      const freshToken = await authorize(authorizationId, authFetch, challenge);
      await assertAuthorization(authorizationId);
      const retryHeaders = new Headers(original.headers);
      retryHeaders.set("authorization", `Bearer ${freshToken}`);
      return await resourceFetch(request.url, { ...original, headers: retryHeaders });
    } finally {
      authority.dispose();
    }
  };
}
