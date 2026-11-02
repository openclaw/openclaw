import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const DISCORD_PUBLIC_API_BASE = "https://discord.com/api/v10";

type DiscordQaRequestInit = RequestInit & { duplex?: "half" };

function requestInitFromDiscordQaRequest(request: Request): DiscordQaRequestInit {
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  };
}

export function createDiscordQaEndpointFetcher(apiBaseUrl: string): typeof fetch {
  const base = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${DISCORD_PUBLIC_API_BASE}/`)) {
      throw new Error(`Discord QA request escaped the expected API base: ${request.url}`);
    }
    const suffix = request.url.slice(`${DISCORD_PUBLIC_API_BASE}/`.length);
    const target = new URL(suffix, base);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromDiscordQaRequest(request),
      signal: request.signal,
      policy: { allowPrivateNetwork: true, allowedOrigins: [base.origin] },
      maxRedirects: 0,
      auditContext: "qa-lab-discord-endpoint",
    });
    try {
      const status = guarded.response.status;
      const bodyAllowed =
        request.method !== "HEAD" &&
        guarded.response.body !== null &&
        status !== 204 &&
        status !== 205 &&
        status !== 304;
      const body = bodyAllowed ? await guarded.response.arrayBuffer() : null;
      return new Response(body && body.byteLength > 0 ? body : null, {
        status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}
