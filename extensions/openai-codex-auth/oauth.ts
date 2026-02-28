import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import * as url from "node:url";

// OpenAI's official OAuth2 endpoints (used by Codex CLI)
const OPENAI_AUTH_BASE = "https://auth.openai.com";
const OPENAI_AUTHORIZE_URL = `${OPENAI_AUTH_BASE}/oauth/authorize`;
const OPENAI_TOKEN_URL = `${OPENAI_AUTH_BASE}/oauth/token`;

// Client ID from env var (override) or official @openai/codex CLI default
const CLIENT_ID = process.env["OPENAI_CODEX_CLIENT_ID"] ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI =
  process.env["OPENAI_CODEX_REDIRECT_URI"] ?? "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email model.request offline_access";

export type CodexOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
};

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function exchangeCodeForToken(params: {
  code: string;
  verifier: string;
}): Promise<CodexOAuthToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: params.verifier,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!payload.access_token) {
    throw new Error("Token exchange returned no access_token.");
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? "",
    expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

function startLocalCallbackServer(params: {
  onCode: (code: string) => void;
  onError: (err: Error) => void;
}): { server: http.Server; port: number } {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url ?? "", true);
    const code = parsedUrl.query["code"] as string | undefined;
    const error = parsedUrl.query["error"] as string | undefined;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (code) {
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✅ OpenAI Codex 認証完了！</h2>
          <p>このタブを閉じてターミナルに戻ってください。</p>
         </body></html>`,
      );
      params.onCode(code);
    } else {
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>❌ 認証に失敗しました</h2>
          <p>${error ?? "Unknown error"}</p>
         </body></html>`,
      );
      params.onError(new Error(`OAuth error: ${error ?? "Unknown"}`));
    }
    server.close();
  });

  server.listen(11435);
  return { server, port: 11435 };
}

export async function loginOpenAICodexOAuth(params: {
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
}): Promise<CodexOAuthToken> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");

  const authUrl = new URL(OPENAI_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeUrl = authUrl.toString();

  // Start local callback server before opening browser
  const code = await new Promise<string>((resolve, reject) => {
    startLocalCallbackServer({
      onCode: resolve,
      onError: reject,
    });

    params
      .note(
        [
          `ブラウザで以下のURLを開いてOpenAIアカウントでログインしてください：`,
          ``,
          authorizeUrl,
        ].join("\n"),
        "OpenAI Codex OAuth2 認証",
      )
      .catch(() => {});

    params.openUrl(authorizeUrl).catch(() => {});
    params.progress.update("ブラウザでの認証を待っています…");
  });

  params.progress.update("トークンを取得中…");
  const token = await exchangeCodeForToken({ code, verifier });
  return token;
}
