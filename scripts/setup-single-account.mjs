#!/usr/bin/env node
/**
 * Single Account Authentication Helper
 * Run this 3 times, once for each account
 * 
 * Usage:
 *   node setup-single-account.mjs account-1
 *   node setup-single-account.mjs account-2
 *   node setup-single-account.mjs account-3
 */

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function requestDeviceCode() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: "read:user",
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  return await res.json();
}

async function pollForAccessToken(deviceCode, intervalMs, expiresAt) {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.access_token) {
      return json.access_token;
    }

    const err = json.error || "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (err === "expired_token") {
      throw new Error("Device code expired; try again");
    }
    if (err === "access_denied") {
      throw new Error("Authorization cancelled");
    }

    throw new Error(`Device flow error: ${err}`);
  }

  throw new Error("Device code expired");
}

async function main() {
  const accountName = process.argv[2];
  
  if (!accountName) {
    console.error("Usage: node setup-single-account.mjs <account-name>");
    console.error("Example: node setup-single-account.mjs account-1");
    process.exit(1);
  }

  console.log(`\n🔑 Authenticating: ${accountName}`);
  console.log("=====================================");

  // Request device code
  console.log("Requesting device code from GitHub...");
  const device = await requestDeviceCode();
  
  console.log("\n📱 AUTHORIZATION REQUIRED");
  console.log(`Visit: ${device.verification_uri}`);
  console.log(`Code: ${device.user_code}`);
  console.log("\n⚠️  IMPORTANT: Sign in with the correct GitHub account!");
  console.log("    If you're already signed in, sign out first.\n");
  console.log("Waiting for authorization...");

  // Poll for token
  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  const accessToken = await pollForAccessToken(device.device_code, intervalMs, expiresAt);
  
  console.log(`\n✅ Success! Token obtained for ${accountName}`);
  console.log(`\nYour token (save this):`);
  console.log(`${accessToken}\n`);
  console.log(`Add to config as:`);
  console.log(`{ name: "${accountName}", token: "${accessToken}" }\n`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
