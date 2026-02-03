#!/usr/bin/env tsx
/**
 * Test X API credentials - run with: bun scripts/test-x-credentials.ts
 *
 * Set these environment variables or edit directly below:
 * - X_CONSUMER_KEY
 * - X_CONSUMER_SECRET
 * - X_ACCESS_TOKEN
 * - X_ACCESS_TOKEN_SECRET
 * - X_PROXY (optional, e.g., http://127.0.0.1:7890)
 */

import crypto from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

const consumerKey = process.env.X_CONSUMER_KEY || "YOUR_CONSUMER_KEY";
const consumerSecret = process.env.X_CONSUMER_SECRET || "YOUR_CONSUMER_SECRET";
const accessToken = process.env.X_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN";
const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET || "YOUR_ACCESS_TOKEN_SECRET";
const proxyUrl = process.env.X_PROXY || process.env.HTTPS_PROXY || "";

/**
 * Generate OAuth 1.0a signature for X API requests
 */
function generateOAuthSignature(
  method: string,
  url: string,
  oauthParams: Record<string, string>,
  consumerSecretVal: string,
  tokenSecretVal: string,
): string {
  const sortedParams = Object.keys(oauthParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(oauthParams[key])}`)
    .join("&");

  const signatureBaseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join("&");

  const signingKey = `${encodeURIComponent(consumerSecretVal)}&${encodeURIComponent(tokenSecretVal)}`;

  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(signatureBaseString)
    .digest("base64");

  return signature;
}

/**
 * Make an OAuth 1.0a authenticated request to X API
 */
async function makeOAuthRequest(url: string): Promise<{ status: number; headers: Headers; body: unknown }> {
  const method = "GET";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  const signature = generateOAuthSignature(method, url, oauthParams, consumerSecret, accessTokenSecret);
  oauthParams.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .map((key) => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
      .join(", ");

  // Use proxy agent if proxy URL is configured
  const fetchOptions: RequestInit & { dispatcher?: unknown } = {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  };

  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    // @ts-ignore - dispatcher is supported by undici/Node.js fetch
    fetchOptions.dispatcher = agent;
  }

  const response = await fetch(url, fetchOptions);

  let body: unknown;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, headers: response.headers, body };
}

async function testCredentials() {
  console.log("Testing X API credentials...\n");

  if (consumerKey === "YOUR_CONSUMER_KEY") {
    console.error("Please set X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET");
    console.error("Example: X_CONSUMER_KEY=xxx X_CONSUMER_SECRET=xxx ... bun scripts/test-x-credentials.ts");
    process.exit(1);
  }

  console.log("Credentials loaded:");
  console.log(`  Consumer Key: ${consumerKey.slice(0, 8)}...`);
  console.log(`  Access Token: ${accessToken.slice(0, 8)}...`);
  console.log(`  Proxy: ${proxyUrl || "(none)"}`);
  console.log();

  try {
    console.log("1. Testing GET /2/users/me (get authenticated user)...");
    const result = await makeOAuthRequest("https://api.x.com/2/users/me?user.fields=id,username,name");

    console.log(`   HTTP Status: ${result.status}`);
    console.log(`   Response: ${JSON.stringify(result.body, null, 2)}`);
    console.log();

    if (result.status === 200) {
      const data = result.body as { data?: { id: string; username: string; name: string } };
      if (data.data) {
        console.log("✓ Success!");
        console.log(`  User: @${data.data.username} (ID: ${data.data.id})`);
        console.log(`  Name: ${data.data.name}`);
      }
    } else {
      console.error("❌ API call failed!\n");
      console.error("Error interpretation:");

      if (result.status === 401) {
        console.error("  - 401 Unauthorized: Invalid credentials");
        console.error("  - Check that your Consumer Key, Consumer Secret, Access Token, and Access Token Secret are correct");
        console.error("  - Make sure you copied the full values without extra spaces");
      } else if (result.status === 403) {
        console.error("  - 403 Forbidden: App doesn't have required permissions");
        console.error("  - Go to developer.x.com > Your App > Settings > User authentication settings");
        console.error("  - Enable OAuth 1.0a with 'Read and write' permissions");
        console.error("  - After changing permissions, regenerate your Access Token and Secret");
      } else if (result.status === 429) {
        console.error("  - 429 Too Many Requests: Rate limit exceeded");
        console.error(`  - Reset at: ${result.headers.get("x-rate-limit-reset")}`);
      } else if (result.status === 400) {
        console.error("  - 400 Bad Request: Check if your app has access to API v2");
        console.error("  - Free tier may have limited access to some endpoints");
      }

      // Show rate limit headers
      const limitRemaining = result.headers.get("x-rate-limit-remaining");
      const limitReset = result.headers.get("x-rate-limit-reset");
      if (limitRemaining || limitReset) {
        console.log("\nRate limit info:");
        console.log(`  Remaining: ${limitRemaining}`);
        console.log(`  Reset: ${limitReset ? new Date(parseInt(limitReset) * 1000).toISOString() : "N/A"}`);
      }

      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Request failed!\n");
    console.error("Error:", error);
    console.error("\nThis might be a network issue. Make sure you can reach api.x.com");
    process.exit(1);
  }
}

testCredentials();
