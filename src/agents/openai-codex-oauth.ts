import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;

type OAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

type OAuthCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void | Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  fetchFn?: typeof fetch;
};

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed" };
type TokenResult = TokenSuccess | TokenFailure;

type JwtPayload = {
  [JWT_CLAIM_PATH]?: {
    chatgpt_account_id?: string;
  };
  [key: string]: unknown;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(challengeBuffer));
  return { verifier, challenge };
}

function createState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
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
    // Accept raw auth code fallback for manual copy flows.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = parts[1] ?? "";
    return JSON.parse(atob(payload)) as JwtPayload;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function resolveOAuthFetch(fetchFn?: typeof fetch): typeof fetch {
  return fetchFn ?? resolveProxyFetchFromEnv() ?? fetch;
}

async function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
  redirectUri?: string;
  fetchFn?: typeof fetch;
}): Promise<TokenResult> {
  const oauthFetch = resolveOAuthFetch(params.fetchFn);
  const response = await oauthFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri ?? REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[openai-codex] code->token failed:", response.status, text);
    return { type: "failed" };
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    console.error("[openai-codex] token response missing fields:", json);
    return { type: "failed" };
  }

  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshOpenAICodexOAuthToken(
  refreshToken: string,
  params?: { fetchFn?: typeof fetch },
): Promise<OAuthCredentials> {
  try {
    const oauthFetch = resolveOAuthFetch(params?.fetchFn);
    const response = await oauthFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[openai-codex] Token refresh failed:", response.status, text);
      throw new Error("Failed to refresh OpenAI Codex token");
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      console.error("[openai-codex] Token refresh response missing fields:", json);
      throw new Error("Failed to refresh OpenAI Codex token");
    }

    const accountId = getAccountId(json.access_token);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }

    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

async function createAuthorizationFlow(
  originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
  const { verifier, challenge } = await generatePkce();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}

type OAuthServerInfo = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

async function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
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
      if (url.searchParams.get("state") !== state) {
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

  return await new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            cancelled = true;
          },
          waitForCode: async () => {
            const sleep = () => new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
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
      .on("error", (err: NodeJS.ErrnoException) => {
        console.error(
          "[openai-codex] Failed to bind http://127.0.0.1:1455 (",
          err.code,
          ") Falling back to manual paste.",
        );
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // Ignore cleanup errors from the fallback path.
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

export async function loginOpenAICodexOAuthFlow(
  options: OAuthCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);
  await options.onAuth({
    url,
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;
  try {
    if (options.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });
      const result = await server.waitForCode();
      if (manualError) {
        throw manualError;
      }
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }
      if (!code) {
        await manualPromise;
        if (manualError) {
          throw manualError;
        }
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }

    if (!code) {
      const input = await options.onPrompt({
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

    options.onProgress?.("Exchanging authorization code for tokens...");
    const tokenResult = await exchangeAuthorizationCode({
      code,
      verifier,
      fetchFn: options.fetchFn,
    });
    if (tokenResult.type !== "success") {
      throw new Error("Token exchange failed");
    }

    const accountId = getAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}
