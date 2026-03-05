#!/usr/bin/env node
/**
 * Multi-Account Authentication Helper
 * Authenticates multiple GitHub Copilot accounts for OpenClaw
 */

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function requestDeviceCode() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: "read:user",
  });

  let lastError;
  // Retry up to 3 times with exponential backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        const waitMs = attempt * 3000; // 3s, 6s
        console.log(`⚠️  Request failed (attempt ${attempt}/3), retrying in ${waitMs/1000}s...`);
        console.log(`   Error: ${err.message}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw lastError;
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

async function authenticateAccount(accountName) {
  console.log(`\n🔑 Authenticating: ${accountName}`);
  console.log("=====================================");

  // Request device code
  console.log("Requesting device code from GitHub...");
  const device = await requestDeviceCode();
  
  console.log("\n📱 AUTHORIZATION REQUIRED");
  console.log(`Visit: ${device.verification_uri}`);
  console.log(`Code: ${device.user_code}`);
  console.log("\nWaiting for authorization...");
  console.log("(Open the URL in your browser and enter the code)");

  // Poll for token
  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  const accessToken = await pollForAccessToken(device.device_code, intervalMs, expiresAt);
  
  console.log(`✅ Success! Token obtained for ${accountName}`);
  return accessToken;
}

async function main() {
  console.log("🦞 OpenClaw Multi-Account Setup");
  console.log("================================\n");
  console.log("This will authenticate 3 GitHub Copilot accounts.\n");
  console.log("For each account:");
  console.log("1. A device code will be displayed");
  console.log("2. Visit https://github.com/login/device");
  console.log("3. Enter the code shown");
  console.log("4. Sign in with that specific GitHub account");
  console.log("5. Authorize OpenClaw\n");

  const tokens = {};

  // Authenticate each account
  for (const accountName of ["account-1", "account-2", "account-3"]) {
    try {
      const token = await authenticateAccount(accountName);
      tokens[accountName] = token;
      
      // Small delay between accounts
      if (accountName !== "account-3") {
        console.log("\n⏳ Waiting 10 seconds before next account...");
        await new Promise(r => setTimeout(r, 10000));
      }
    } catch (err) {
      console.error(`\n❌ Failed to authenticate ${accountName}:`, err.message);
      process.exit(1);
    }
  }

  // Generate config snippet
  console.log("\n\n✅ All accounts authenticated!");
  console.log("\n📋 Add this to your OpenClaw config:");
  console.log("=====================================");
  console.log(JSON.stringify({
    githubCopilot: {
      accounts: [
        { name: "account-1", token: tokens["account-1"] },
        { name: "account-2", token: tokens["account-2"] },
        { name: "account-3", token: tokens["account-3"] },
      ],
      loadBalancing: "round-robin"
    }
  }, null, 2));
  console.log("=====================================\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
