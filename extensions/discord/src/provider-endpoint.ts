// Discord plugin module owns private alternate-provider endpoint routing.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  isLoopbackHost,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DISCORD_DEFAULT_REST_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_PROVIDER_ENDPOINT_ENV = "DISCORD_PROVIDER_ENDPOINT";

const DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES = 8 * 1024;
const DISCORD_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_PROVIDER_ENDPOINT_DESCRIPTOR_KEYS = [
  "restApiBaseUrl",
  "gatewayBotUrl",
  "gatewayOrigin",
] as const;

type DiscordProviderEndpointDescriptor = Readonly<{
  /** Complete versioned base URL for Discord REST routes. */
  restApiBaseUrl: string;
  /** Exact authenticated Gateway metadata URL. */
  gatewayBotUrl: string;
  /** Allowed WebSocket origin for initial and resumed Gateway connections. */
  gatewayOrigin: string;
}>;

type DiscordProviderEndpointRuntime = Readonly<{
  descriptor: DiscordProviderEndpointDescriptor;
  fetch: typeof fetch;
}>;

type DiscordProviderEndpointInitialization =
  | Readonly<{ status: "uninitialized" }>
  | Readonly<{ status: "initialized"; runtime: DiscordProviderEndpointRuntime | undefined }>
  | Readonly<{ status: "failed"; error: Error }>;

let providerEndpointInitialization: DiscordProviderEndpointInitialization = {
  status: "uninitialized",
};

function parseHttpAnchor(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url;
}

function normalizeRestApiBaseUrl(value: string): URL {
  const url = parseHttpAnchor(value, "Discord provider REST API base URL");
  if (url.search) {
    throw new Error("Discord provider REST API base URL must not contain a query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function normalizeGatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Discord provider Gateway origin must be a valid URL");
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) {
    throw new Error("Discord provider Gateway origin must use WSS or loopback WS");
  }
  // IP literals bypass the HTTPS agent's DNS lookup, so reject blocked targets here;
  // known local and metadata hostnames should fail before any token-bearing socket starts.
  if (url.protocol === "wss:" && isBlockedHostnameOrIp(url.hostname)) {
    throw new Error(
      "Discord provider Gateway origin must not target a private/internal/special-use hostname or IP address",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Discord provider Gateway origin must not contain credentials or a fragment");
  }
  if (url.pathname !== "/" || url.search) {
    throw new Error("Discord provider Gateway origin must not contain a path or query");
  }
  return url.origin;
}

function normalizeDescriptor(
  descriptor: DiscordProviderEndpointDescriptor,
): DiscordProviderEndpointDescriptor {
  const restApiBaseUrl = normalizeRestApiBaseUrl(descriptor.restApiBaseUrl);
  const gatewayBotUrl = parseHttpAnchor(
    descriptor.gatewayBotUrl,
    "Discord provider Gateway metadata URL",
  );
  return Object.freeze({
    restApiBaseUrl: restApiBaseUrl.toString().replace(/\/$/u, ""),
    gatewayBotUrl: gatewayBotUrl.toString(),
    gatewayOrigin: normalizeGatewayOrigin(descriptor.gatewayOrigin),
  });
}

function parseProviderEndpointDescriptor(rawValue: string): DiscordProviderEndpointDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(`${DISCORD_PROVIDER_ENDPOINT_ENV} must contain valid JSON`);
  }
  const keys = isRecord(parsed) ? Object.keys(parsed).toSorted() : [];
  const expectedKeys = DISCORD_PROVIDER_ENDPOINT_DESCRIPTOR_KEYS.toSorted();
  if (
    !isRecord(parsed) ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      `${DISCORD_PROVIDER_ENDPOINT_ENV} must contain exactly restApiBaseUrl, gatewayBotUrl, and gatewayOrigin`,
    );
  }
  for (const key of DISCORD_PROVIDER_ENDPOINT_DESCRIPTOR_KEYS) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`${DISCORD_PROVIDER_ENDPOINT_ENV}.${key} must be a non-empty string`);
    }
  }
  return normalizeDescriptor({
    restApiBaseUrl: (parsed.restApiBaseUrl as string).trim(),
    gatewayBotUrl: (parsed.gatewayBotUrl as string).trim(),
    gatewayOrigin: (parsed.gatewayOrigin as string).trim(),
  });
}

function parseProviderEndpointEnv(
  rawValue: string | undefined,
): DiscordProviderEndpointDescriptor | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(rawValue, "utf8") > DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES) {
    throw new Error(
      `${DISCORD_PROVIDER_ENDPOINT_ENV} exceeds ${DISCORD_PROVIDER_ENDPOINT_ENV_MAX_BYTES} bytes`,
    );
  }
  return rawValue.trim() ? parseProviderEndpointDescriptor(rawValue) : undefined;
}

function isWithinRestApiBase(target: URL, restApiBaseUrl: URL): boolean {
  if (target.origin !== restApiBaseUrl.origin) {
    return false;
  }
  const basePath = restApiBaseUrl.pathname.replace(/\/+$/u, "");
  return (
    basePath === "" || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  );
}

function assertProviderHttpTarget(
  target: URL,
  descriptor: DiscordProviderEndpointDescriptor,
): void {
  const restApiBaseUrl = new URL(descriptor.restApiBaseUrl);
  const gatewayBotUrl = new URL(descriptor.gatewayBotUrl);
  if (
    !isWithinRestApiBase(target, restApiBaseUrl) &&
    target.toString() !== gatewayBotUrl.toString()
  ) {
    throw new Error("Discord provider request is outside the configured endpoint boundaries");
  }
}

function requestInitFromRequest(request: Request): RequestInit {
  const duplex = (request as Request & { duplex?: "half" }).duplex;
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body
      ? {
          body: request.body as BodyInit,
          ...(duplex ? { duplex } : {}),
        }
      : {}),
    signal: request.signal,
  };
}

function createProviderFetch(descriptor: DiscordProviderEndpointDescriptor): typeof fetch {
  const allowedOrigins = Array.from(
    new Set([new URL(descriptor.restApiBaseUrl).origin, new URL(descriptor.gatewayBotUrl).origin]),
  );
  return async (input, init) => {
    // Rebuild once so Request inputs and RequestInit overrides retain Fetch semantics.
    const request = new Request(input, init);
    const target = new URL(request.url);
    assertProviderHttpTarget(target, descriptor);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromRequest(request),
      signal: request.signal,
      requireHttps: target.protocol === "https:",
      policy: { allowedOrigins },
      maxRedirects: 0,
      capture: false,
      auditContext: "discord.provider-endpoint",
    });
    try {
      const body = await readResponseWithLimit(
        guarded.response,
        DISCORD_PROVIDER_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      return new Response(body.byteLength > 0 ? (body as unknown as BodyInit) : null, {
        status: guarded.response.status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}

/** Snapshot the private endpoint once, before any Discord account can start. */
export function initializeDiscordProviderEndpointFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordProviderEndpointRuntime | undefined {
  if (providerEndpointInitialization.status === "initialized") {
    return providerEndpointInitialization.runtime;
  }
  if (providerEndpointInitialization.status === "failed") {
    throw providerEndpointInitialization.error;
  }

  try {
    const rawValue = env[DISCORD_PROVIDER_ENDPOINT_ENV];
    const descriptor = parseProviderEndpointEnv(rawValue);
    const runtime = descriptor
      ? Object.freeze({ descriptor, fetch: createProviderFetch(descriptor) })
      : undefined;
    providerEndpointInitialization = { status: "initialized", runtime };
    return runtime;
  } catch (error) {
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    // Cache invalid input too: late environment mutation must not change routing after startup.
    providerEndpointInitialization = { status: "failed", error: resolvedError };
    throw resolvedError;
  }
}

export function getDiscordProviderEndpointRuntime(): DiscordProviderEndpointRuntime | undefined {
  return providerEndpointInitialization.status === "initialized"
    ? providerEndpointInitialization.runtime
    : undefined;
}

export function resolveDiscordProviderAttachmentUploadGuard(uploadUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
      requireHttps: boolean;
    }>
  | undefined {
  const runtime = getDiscordProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(uploadUrl, "Discord provider attachment upload URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord provider attachment upload URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    policy: { allowedOrigins: [restOrigin] },
    requireHttps: target.protocol === "https:",
  };
}

export function resolveDiscordProviderMediaDownloadGuard(mediaUrl: string):
  | Readonly<{
      maxRedirects: 0;
      policy: SsrFPolicy;
    }>
  | undefined {
  const runtime = getDiscordProviderEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  const target = parseHttpAnchor(mediaUrl, "Discord provider media URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    return undefined;
  }
  return {
    maxRedirects: 0,
    policy: {
      allowedOrigins: [restOrigin],
      hostnameAllowlist: [target.hostname],
    },
  };
}

export function assertDiscordProviderGatewayUrl(url: string, gatewayOrigin?: string): void {
  if (!gatewayOrigin) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Discord provider Gateway returned an invalid WebSocket URL");
  }
  if (parsed.origin !== gatewayOrigin || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Discord provider Gateway URL is outside the configured WebSocket origin");
  }
}
