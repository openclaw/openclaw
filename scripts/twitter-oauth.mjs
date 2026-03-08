#!/usr/bin/env node
/**
 * twitter-oauth.mjs
 * OAuth 2.0 Authorization Code Flow with PKCE for Twitter/X.
 *
 * Usage:
 *   node scripts/twitter-oauth.mjs --client-id YOUR_CLIENT_ID [--client-secret YOUR_CLIENT_SECRET]
 *
 * Steps:
 *   1. Opens a URL in your browser — log in with the account you want to authorize (e.g. @trust8004)
 *   2. After you authorize, it captures the callback and exchanges the code for tokens
 *   3. Prints the access token, refresh token, and user ID
 */

import crypto from "node:crypto";
import http from "node:http";
import { URL, URLSearchParams } from "node:url";

const PORT = 9876;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "follows.read",
  "follows.write",
  "offline.access",
].join(" ");

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--client-id" && args[i + 1]) {
      flags.clientId = args[++i];
    } else if (args[i] === "--client-secret" && args[i + 1]) {
      flags.clientSecret = args[++i];
    }
  }
  if (!flags.clientId) {
    console.error(
      "Usage: node scripts/twitter-oauth.mjs --client-id YOUR_CLIENT_ID [--client-secret YOUR_CLIENT_SECRET]",
    );
    process.exit(1);
  }
  return flags;
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function exchangeCode(code, verifier, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: clientId,
  });

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  // If client secret is provided, use Basic auth (confidential client)
  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function fetchMe(accessToken) {
  const res = await fetch("https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch user (${res.status}): ${text}`);
  }

  return res.json();
}

async function main() {
  const { clientId, clientSecret } = parseArgs();
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL("https://x.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("\n=== Twitter/X OAuth 2.0 Authorization ===\n");
  console.log(
    "1. Open this URL in a browser where you are logged into the account you want to authorize:\n",
  );
  console.log(`   ${authUrl.toString()}\n`);
  console.log("2. Authorize the app when prompted");
  console.log(`3. You will be redirected to localhost:${PORT} — this script will capture it\n`);
  console.log(`Waiting for callback on http://localhost:${PORT} ...\n`);

  // Start local server to capture the callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const receivedState = url.searchParams.get("state");
      const receivedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization denied</h1><p>${error}</p>`);
        reject(new Error(`Authorization denied: ${error}`));
        server.close();
        return;
      }

      if (receivedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1>");
        reject(new Error("State mismatch"));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>",
      );
      resolve(receivedCode);
      server.close();
    });

    server.listen(PORT, () => {});
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${PORT} is in use. Close any process using it and try again.`));
      } else {
        reject(err);
      }
    });
  });

  console.log("Authorization code received. Exchanging for tokens...\n");

  const tokens = await exchangeCode(code, verifier, clientId, clientSecret);
  const me = await fetchMe(tokens.access_token);

  console.log("=== SUCCESS ===\n");
  console.log(`Authorized account: @${me.data.username} (${me.data.name})`);
  console.log(`User ID: ${me.data.id}\n`);
  console.log("--- Add these to your Dokploy environment variables ---\n");
  console.log(`TWITTER_BEARER_TOKEN=${tokens.access_token}`);
  console.log(`TWITTER_USER_ID=${me.data.id}`);
  if (tokens.refresh_token) {
    console.log(`TWITTER_REFRESH_TOKEN=${tokens.refresh_token}`);
  }
  console.log(`\n--- Token info ---`);
  console.log(`Expires in: ${tokens.expires_in} seconds`);
  console.log(`Scopes: ${tokens.scope}`);
  if (tokens.refresh_token) {
    console.log(
      `\nIMPORTANT: Save the refresh token. The access token expires in ${Math.round(tokens.expires_in / 3600)} hours.`,
    );
    console.log(
      "You will need the refresh token to get a new access token without re-authorizing.",
    );
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
