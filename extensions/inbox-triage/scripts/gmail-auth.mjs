#!/usr/bin/env node
/**
 * One-shot Gmail OAuth helper.
 *
 * Run from the extension directory:
 *
 *   pnpm --filter @openclaw/inbox-triage gmail:auth
 *
 * It opens a browser for consent and prints the long-lived refresh token
 * to stdout. Paste it into deploy/.env as GMAIL_OAUTH_REFRESH_TOKEN.
 *
 * Requires GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET to be set
 * in the environment beforehand (from the Desktop OAuth client JSON
 * downloaded from Google Cloud Console).
 */

import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";
import { google } from "googleapis";

const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;
const PORT = Number(process.env.GMAIL_OAUTH_PORT ?? 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET first.");
  process.exit(1);
}

const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const authUrl = oauth.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log("\nOpening your browser for Google consent…");
console.log("If it doesn't open, visit this URL manually:\n");
console.log(authUrl);
console.log("");

const open = (url) => {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
};
open(authUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/oauth2callback") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.statusCode = 400;
    res.end("missing ?code");
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    res.setHeader("content-type", "text/plain");
    res.end("Refresh token received — you can close this tab.");
    console.log("\n=== GMAIL_OAUTH_REFRESH_TOKEN ===");
    console.log(tokens.refresh_token ?? "(no refresh token returned — re-run with prompt=consent)");
    console.log("=================================\n");
  } catch (err) {
    res.statusCode = 500;
    res.end(`token exchange failed: ${String(err)}`);
    console.error("Token exchange failed:", err);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Listening for OAuth callback on ${REDIRECT}\n`);
});
