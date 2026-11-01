import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { getDiscordEndpointRuntime, type DiscordEndpointRuntime } from "./endpoint-runtime.js";
const DISCORD_HOST = "discord.com";
const DISCORD_OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const JSON_MAX_BYTES = 64 * 1024;

export async function fetchDiscordJson(params: {
  fetchImpl?: typeof fetch;
  url: string;
  init: RequestInit;
  auditContext: string;
  endpointRuntime?: DiscordEndpointRuntime | null;
}): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  const endpoint = Object.hasOwn(params, "endpointRuntime")
    ? params.endpointRuntime
    : getDiscordEndpointRuntime();
  const liveUrl = new URL(params.url);
  const endpointPath =
    liveUrl.pathname === "/api/oauth2/token"
      ? "/oauth2/token"
      : liveUrl.pathname.startsWith("/api/v10/")
        ? liveUrl.pathname.slice("/api/v10".length)
        : undefined;
  if (endpoint && !endpointPath) {
    throw new Error("Discord request is outside the configured endpoint routes");
  }
  const guarded = endpoint
    ? {
        response: await endpoint.fetch(
          `${endpoint.descriptor.restApiBaseUrl}${endpointPath}${liveUrl.search}`,
          {
            ...params.init,
            signal: params.init.signal
              ? AbortSignal.any([
                  params.init.signal,
                  AbortSignal.timeout(DISCORD_OAUTH_REQUEST_TIMEOUT_MS),
                ])
              : AbortSignal.timeout(DISCORD_OAUTH_REQUEST_TIMEOUT_MS),
          },
        ),
        release: async () => {},
      }
    : await fetchWithSsrFGuard({
        url: params.url,
        fetchImpl: params.fetchImpl,
        init: params.init,
        policy: { allowedHostnames: [DISCORD_HOST] },
        auditContext: params.auditContext,
        timeoutMs: DISCORD_OAUTH_REQUEST_TIMEOUT_MS,
      });
  const { response, release } = guarded;
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    return {
      ok: true,
      body: await readProviderJsonResponse<Record<string, unknown>>(response, "Discord OAuth", {
        maxBytes: JSON_MAX_BYTES,
      }),
    };
  } finally {
    await release();
  }
}
