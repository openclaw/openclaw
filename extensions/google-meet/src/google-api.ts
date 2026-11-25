import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const REAUTH_HINT = "Re-run `openclaw googlemeet auth login` and store the refreshed oauth block.";
const GOOGLE_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

export async function readGoogleApiErrorDetail(response: Response): Promise<string> {
  return await readResponseTextLimited(response, GOOGLE_API_ERROR_BODY_LIMIT_BYTES);
}

type GoogleApiQuery = Record<string, string | number | boolean | undefined>;

function appendQuery(url: string, query?: GoogleApiQuery): string {
  if (!query) {
    return url;
  }
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

export async function requestGoogleApi<T>(
  params: {
    url: string;
    query?: GoogleApiQuery;
    accessToken: string;
    allowedHostname: string;
    auditContext: string;
    prefix: string;
    scopes?: readonly string[];
    accept?: string;
    init?: { method?: "GET" | "POST"; body?: string };
  },
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: appendQuery(params.url, params.query),
    init: {
      ...params.init,
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: params.accept ?? "application/json",
        ...(params.init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    },
    policy: { allowedHostnames: [params.allowedHostname] },
    auditContext: params.auditContext,
    timeoutMs: 30_000,
  });
  try {
    if (!response.ok) {
      const detail = await readGoogleApiErrorDetail(response);
      const scopeHint =
        params.scopes && params.scopes.length > 0
          ? ` Required OAuth scope: ${params.scopes.map((scope) => `\`${scope}\``).join(", ")}. ${REAUTH_HINT}`
          : "";
      throw new Error(`${params.prefix} failed (${response.status}): ${detail}${scopeHint}`);
    }
    return await read(response);
  } finally {
    await release();
  }
}
