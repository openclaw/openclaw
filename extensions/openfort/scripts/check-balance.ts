#!/usr/bin/env node

/**
 * Check balance of a specific Openfort wallet
 */

import Openfort from "@openfort/openfort-node";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const secretKey = process.env.OPENFORT_SECRET_KEY || process.argv[2];
const walletSecret = process.env.OPENFORT_WALLET_SECRET || process.argv[3];

if (!secretKey || !walletSecret) {
  console.error("Usage: node check-balance.js SK_KEY WALLET_SECRET");
  process.exit(1);
}

console.log("💰 Checking Openfort Wallet Balances\n");

async function checkBalances() {
  try {
    const openfort = new Openfort(secretKey, {
      walletSecret: walletSecret,
    });

    console.log("📋 Fetching all accounts...");
    const response = await openfort.accounts.evm.backend.list({ limit: 100 });

    // Handle both array and paginated response
    const accounts = Array.isArray(response) ? response : response.data || [];

    if (accounts.length === 0) {
      console.log("❌ No accounts found. Creating one...");
      const newAccount = await openfort.accounts.evm.backend.create();
      console.log(`✅ Created new account: ${newAccount.address}\n`);
      console.log("💡 Send tokens to this address on Base Sepolia:");
      console.log(`   ${newAccount.address}`);
      return;
    }

    console.log(`✅ Found ${accounts.length} account(s)\n`);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      console.log(`Account ${i + 1}:`);
      console.log(`  Address: ${account.address}`);

      const balance = await publicClient.getBalance({
        address: account.address,
      });

      const balanceEth = (Number(balance) / 1e18).toFixed(6);
      console.log(`  Balance: ${balanceEth} ETH`);

      if (Number(balance) > 0) {
        console.log(`  🎉 This wallet has funds!`);
      }
      console.log("");
    }

    // Find account with balance
    const fundedAccount = accounts.find(async (acc) => {
      const bal = await publicClient.getBalance({ address: acc.address });
      return Number(bal) > 0;
    });

    if (fundedAccount) {
      console.log("💡 To send a test transaction, run:");
      console.log(`   node send-transaction.js ${fundedAccount.address}`);
    }
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.response) {
      console.error("   API Response:", error.response.data);
    }
    process.exit(1);
  }
}

checkBalances();
