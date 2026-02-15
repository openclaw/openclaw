import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { coerceExpiresAt } from "./oauth-utils.js";

/**
 * Anthropic OAuth token refresh using the Claude platform endpoint.
 * Mirrors the Claude Code CLI's own refresh flow.
 */

const ANTHROPIC_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export type AnthropicStoredOAuth = OAuthCredentials & {
  clientId?: string;
};

export async function refreshAnthropicTokens(params: {
  credential: AnthropicStoredOAuth;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<AnthropicStoredOAuth> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();

  const refreshToken = params.credential.refresh?.trim();
  if (!refreshToken) {
    throw new Error("Anthropic OAuth credential is missing refresh token");
  }

  const clientId =
    params.credential.clientId?.trim() ??
    process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() ??
    ANTHROPIC_CLIENT_ID;

  // Claude platform token endpoint uses JSON, not form-urlencoded
  const response = await fetchFn(ANTHROPIC_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    let detail = `status ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      detail = body.error_description || body.error || detail;
    } catch {
      // response wasn't JSON; use status code only
    }
    throw new Error(`Anthropic token refresh failed: ${detail}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const newRefresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 3600;

  if (!access) {
    throw new Error("Anthropic token refresh returned no access_token");
  }

  return {
    ...params.credential,
    access,
    refresh: newRefresh || refreshToken,
    expires: coerceExpiresAt(expiresIn, now),
    clientId,
  } as unknown as AnthropicStoredOAuth;
}
