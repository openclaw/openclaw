/**
 * Enhanced OpenAI Codex OAuth provider.
 *
 * The upstream pi-ai OAuth flow requests only `openid profile email offline_access`,
 * which is insufficient for GPT-5+ models that require `model.request` (Completions API)
 * or `api.responses.write` (Responses API). This module overrides the built-in provider
 * with one that requests the necessary scopes and handles accountId extraction resiliently.
 *
 * See: https://github.com/openclaw/openclaw/issues/27055
 */
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider } from "@mariozechner/pi-ai";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const ENHANCED_SCOPE = "openid profile email offline_access model.request api.responses.write";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const SUCCESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Authentication successful</title></head>
<body><p>Authentication successful. Return to your terminal to continue.</p></body></html>`;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return { verifier, challenge: base64urlEncode(new Uint8Array(hashBuffer)) };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    return JSON.parse(atob(parts[1] ?? "")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function parseAuthorizationInput(input: string | undefined | null): {
  code?: string;
  state?: string;
} {
  const value = (input ?? "").trim();
  if (!value) {
    return {};
  }
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<
  { type: "success"; access: string; refresh: string; expires: number } | { type: "failed" }
> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    return { type: "failed" };
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    return { type: "failed" };
  }
  return {
    type: "success",
    access: json.access_token as string,
    refresh: json.refresh_token as string,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<
  { type: "success"; access: string; refresh: string; expires: number } | { type: "failed" }
> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) {
      return { type: "failed" };
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      return { type: "failed" };
    }
    return {
      type: "success",
      access: json.access_token as string,
      refresh: json.refresh_token as string,
      expires: Date.now() + json.expires_in * 1000,
    };
  } catch {
    return { type: "failed" };
  }
}

type LocalServerHandle = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

async function startLocalOAuthServer(expectedState: string): Promise<LocalServerHandle> {
  const { createServer } = await import("node:http");
  let lastCode: string | null = null;
  let cancelled = false;

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      lastCode = code;
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            cancelled = true;
          },
          waitForCode: async () => {
            const sleep = () => new Promise<void>((r) => setTimeout(r, 100));
            for (let i = 0; i < 600; i += 1) {
              if (lastCode) {
                return { code: lastCode };
              }
              if (cancelled) {
                return null;
              }
              await sleep();
            }
            return null;
          },
        });
      })
      .on("error", () => {
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // ignore
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

async function createAuthorizationFlow(): Promise<{
  verifier: string;
  state: string;
  url: string;
}> {
  const { randomBytes } = await import("node:crypto");
  const { verifier, challenge } = await generatePKCE();
  const state = randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", ENHANCED_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return { verifier, state, url: url.toString() };
}

/**
 * Enhanced Codex OAuth login that requests additional API scopes
 * (`model.request`, `api.responses.write`) so GPT-5+ models work.
 *
 * AccountId extraction is resilient: returns null instead of throwing
 * when the JWT doesn't contain the expected claim.
 */
export async function loginOpenAICodexEnhanced(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow();
  const server = await startLocalOAuthServer(state);
  callbacks.onAuth({
    url,
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;
  try {
    const result = await server.waitForCode();
    if (result?.code) {
      code = result.code;
    }

    if (!code) {
      const input = await callbacks.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") {
      throw new Error("Token exchange failed");
    }

    const accountId = extractAccountId(tokenResult.access);
    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      ...(accountId ? { accountId } : {}),
    };
  } finally {
    server.close();
  }
}

/**
 * Enhanced Codex token refresh with resilient accountId handling.
 *
 * When the refreshed JWT no longer contains chatgpt_account_id,
 * falls back to the previously stored accountId.
 */
export async function refreshOpenAICodexTokenEnhanced(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const result = await refreshAccessToken(credentials.refresh);
  if (result.type !== "success") {
    throw new Error("Failed to refresh OpenAI Codex token");
  }

  const accountId =
    extractAccountId(result.access) ??
    (typeof credentials.accountId === "string" ? credentials.accountId : null);

  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    ...(accountId ? { accountId } : {}),
  };
}

const enhancedCodexOAuthProvider: OAuthProviderInterface = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,
  login: loginOpenAICodexEnhanced,
  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshOpenAICodexTokenEnhanced(credentials);
  },
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};

let registered = false;

/**
 * Register the enhanced OpenAI Codex OAuth provider, overriding pi-ai's
 * built-in provider with one that requests additional API scopes.
 *
 * Safe to call multiple times (idempotent).
 */
export function registerEnhancedCodexOAuth(): void {
  if (registered) {
    return;
  }
  try {
    registerOAuthProvider(enhancedCodexOAuthProvider);
    registered = true;
  } catch {
    // In test environments @mariozechner/pi-ai may be mocked without
    // registerOAuthProvider; silently skip registration.
  }
}
