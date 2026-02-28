#!/usr/bin/env node

/**
 * Upgrade Backend Wallet to EIP-7702 Delegated Account
 * Uses Calibur implementation on Base Sepolia
 */

import Openfort from "@openfort/openfort-node";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];
const walletAddress = process.argv[4] || "0x806560fbb6aee62da1ca1cafa7275186a07fb02a";

const BASE_SEPOLIA_CHAIN_ID = 84532;

console.log("🔄 Upgrading to EIP-7702 Delegated Account\n");

async function upgradeToDelegated() {
  try {
    const openfort = new Openfort(secretKey, { walletSecret });

    // Step 1: Find the account
    console.log("1️⃣  Finding backend wallet...");
    console.log(`   Address: ${walletAddress}\n`);

    const result = await openfort.accounts.evm.backend.list({ limit: 100 });
    const accounts = result.accounts || [];

    const account = accounts.find(
      (acc) => acc.address.toLowerCase() === walletAddress.toLowerCase(),
    );

    if (!account) {
      console.error("❌ Wallet not found!");
      console.log("   Available wallets:");
      accounts.forEach((acc) => console.log(`   - ${acc.address}`));
      return;
    }

    console.log(`✅ Found account: ${account.id}`);
    console.log(`   Address: ${account.address}`);
    console.log(`   Custody: ${account.custody}\n`);

    // Step 2: Upgrade to Delegated Account (EIP-7702)
    console.log("2️⃣  Upgrading to EIP-7702 Delegated Account...");
    console.log("   Account Type: Delegated Account");
    console.log("   Chain: Base Sepolia (84532)");
    console.log("   Implementation: Calibur\n");

    const updated = await openfort.accounts.evm.backend.update({
      id: account.id,
      accountType: "Delegated Account",
      chainType: "EVM",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      implementationType: "Calibur",
    });

    console.log("✅ Upgraded successfully!");
    console.log(`   Account ID: ${updated.id}`);
    console.log(`   Address: ${updated.address}`);

    if (updated.delegatedAccount) {
      console.log(`   Delegated Account ID: ${updated.delegatedAccount.id}`);
      console.log(`   Implementation: ${updated.delegatedAccount.implementationType}`);
      console.log(`   Chain: ${updated.delegatedAccount.chainId}`);
    }
    console.log("");

    console.log("🎉 EIP-7702 Delegation Complete!\n");

    console.log("📋 What changed:");
    console.log("   - EOA upgraded to smart account via EIP-7702");
    console.log("   - Can now use ERC-4337 features (paymasters, batching)");
    console.log("   - USDC gas payment now enabled via fee sponsorship");
    console.log("   - Maintains same address (no migration needed)\n");

    console.log("🔗 Calibur Implementation:");
    console.log("   - Modular delegator contract");
    console.log("   - Supports batch transactions");
    console.log("   - Session keys enabled");
    console.log("   - Paymaster compatible ✅\n");

    return updated;
  } catch (error) {
    console.error("\n❌ Error:", error.message || error);
    if (error.errorMessage) {
      console.error("Details:", JSON.stringify(error.errorMessage, null, 2));
    }
    if (error.response) {
      console.error("Response:", JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

upgradeToDelegated();
