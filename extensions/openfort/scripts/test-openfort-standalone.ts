#!/usr/bin/env node

/**
 * Standalone Openfort Test
 * Tests your Openfort credentials and wallet functionality
 */

import Openfort from "@openfort/openfort-node";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// Get credentials from command line
const secretKey = process.env.OPENFORT_SECRET_KEY || process.argv[2];
const walletSecret = process.env.OPENFORT_WALLET_SECRET || process.argv[3];

if (!secretKey || !walletSecret) {
  console.error("Usage: node test-openfort-standalone.js SK_KEY WALLET_SECRET");
  console.error("Or set OPENFORT_SECRET_KEY and OPENFORT_WALLET_SECRET env vars");
  process.exit(1);
}

console.log("🧪 Testing Openfort Integration\n");

async function test() {
  try {
    // Initialize Openfort
    console.log("1️⃣  Initializing Openfort client...");
    const openfort = new Openfort(secretKey, {
      walletSecret: walletSecret,
    });
    console.log("✅ Client initialized\n");

    // Get or create account
    console.log("2️⃣  Getting backend wallet account...");
    const accounts = await openfort.accounts.evm.backend.list({ limit: 1 });

    let account;
    if (accounts.length > 0) {
      account = accounts[0];
      console.log(`✅ Found existing account: ${account.address}\n`);
    } else {
      console.log("   No accounts found, creating new one...");
      account = await openfort.accounts.evm.backend.create();
      console.log(`✅ Created new account: ${account.address}\n`);
    }

    // Sign a message
    console.log("3️⃣  Signing a test message...");
    const message = "Hello from OpenClaw + Openfort!";
    const signature = await account.signMessage({ message });
    console.log(`✅ Message signed!`);
    console.log(`   Message: "${message}"`);
    console.log(`   Signature: ${signature.substring(0, 20)}...\n`);

    // Get balance
    console.log("4️⃣  Checking wallet balance...");
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });

    const balance = await publicClient.getBalance({
      address: account.address,
    });

    const balanceEth = (Number(balance) / 1e18).toFixed(6);
    console.log(`✅ Balance: ${balanceEth} ETH on Base Sepolia\n`);

    // List all accounts
    console.log("5️⃣  Listing all accounts...");
    const allAccounts = await openfort.accounts.evm.backend.list({ limit: 10 });
    const accountArray = Array.isArray(allAccounts) ? allAccounts : allAccounts.data || [];
    console.log(`✅ Found ${accountArray.length} account(s):`);
    accountArray.forEach((acc, i) => {
      console.log(`   ${i + 1}. ${acc.address}`);
    });

    console.log("\n🎉 All tests passed!\n");
    console.log("📝 Summary:");
    console.log(`   Wallet Address: ${account.address}`);
    console.log(`   Network: Base Sepolia`);
    console.log(`   Balance: ${balanceEth} ETH`);
    console.log(`   Total Accounts: ${accountArray.length}`);
    console.log("\n✅ Your Openfort integration is working correctly!");
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.response) {
      console.error("   API Response:", error.response.data);
    }
    process.exit(1);
  }
}

test();
