import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getMcpRequestContext } from "./mcp-request-context.js";

type FetchLike = NonNullable<GuardedFetchOptions["fetchImpl"]>;

const REQUEST_HEADER_TIMEOUT_MS = 10_000;
const PROTECTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "content-type",
  "accept",
  "last-event-id",
]);

/** Capture the registry owner, but resolve volatile values at each actual HTTP request. */
export function withMcpRequestHeaders(params: {
  serverName: string;
  resourceUrl: string;
  fetchFn: FetchLike;
}): FetchLike {
  const registry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
  const provider = registry?.mcpServerRequestHeaderProviders?.find(
    (entry) => entry.provider.serverName === params.serverName,
  )?.provider;
  if (!provider) {
    return params.fetchFn;
  }
  const origin = new URL(params.resourceUrl).origin;
  return async (input, init) => {
    const context = getMcpRequestContext();
    const url = input instanceof Request ? input.url : input;
    if (!context || new URL(url).origin !== origin) {
      return params.fetchFn(input, init);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    try {
      const values = await Promise.race([
        Promise.resolve().then(() => provider.resolve(context)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("MCP request header provider timed out")),
            REQUEST_HEADER_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      for (const [name, value] of Object.entries(values ?? {})) {
        if (typeof value !== "string") {
          throw new Error("Invalid MCP request header");
        }
        registerSecretValueForRedaction(value);
        const bareToken = value.trim().split(/\s+/).at(-1);
        if (bareToken && bareToken !== value) {
          registerSecretValueForRedaction(bareToken);
        }
        // Providers add attribution; stable auth and SDK protocol fields keep ownership.
        const key = name.toLowerCase();
        if (!headers.has(key) && !PROTECTED_HEADERS.has(key) && !key.startsWith("mcp-")) {
          headers.set(name, value);
        }
      }
    } catch {
      // Plugin errors can contain credentials. Never attach the original error or values.
      throw new Error("MCP request header provider failed");
    } finally {
      clearTimeout(timer);
    }
    init?.signal?.throwIfAborted();
    if (getMcpRequestContext() !== context) {
      throw new Error("MCP request context expired");
    }
    return params.fetchFn(input, { ...init, headers });
  };
}
