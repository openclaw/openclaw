#!/usr/bin/env node

/**
 * Final Fee Sponsorship Setup - Exact SDK Example Pattern
 * Based on official Openfort SDK examples
 */

import Openfort from "@openfort/openfort-node";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];

const BASE_SEPOLIA_CHAIN_ID = 84532;

console.log("⚙️  Setting up Fee Sponsorship (Official SDK Pattern)\n");

async function setup() {
  try {
    const openfort = new Openfort(secretKey, { walletSecret });

    // 1. Create a policy with criteria rules
    console.log("1️⃣  Creating policy...");
    const policy = await openfort.policies.create({
      scope: "project",
      description: "Sponsor all transactions on Base Sepolia",
      rules: [
        {
          action: "accept",
          operation: "sponsorEvmTransaction",
          criteria: [{ type: "evmNetwork", operator: "in", chainIds: [BASE_SEPOLIA_CHAIN_ID] }],
        },
      ],
    });
    console.log("✅ Created policy:", policy.id, "\n");

    // 2. Create a fee sponsorship linked to that policy
    console.log("2️⃣  Creating fee sponsorship...");
    const sponsorship = await openfort.feeSponsorship.create({
      name: "Gas Sponsorship - Base Sepolia",
      strategy: {
        sponsorSchema: "pay_for_user",
      },
      policyId: policy.id,
    });

    console.log("✅ Created fee sponsorship:");
    console.log("  ID:", sponsorship.id);
    console.log("  Name:", sponsorship.name);
    console.log("  Strategy:", sponsorship.strategy.sponsorSchema);
    console.log("  Policy ID:", sponsorship.policyId);
    console.log("");

    console.log("🎉 Setup Complete!\n");

    console.log("📋 How it works:");
    console.log("   - All Base Sepolia (84532) transactions are sponsored");
    console.log("   - Openfort paymaster pays all gas fees");
    console.log("   - Users need 0 ETH\n");

    console.log("🔗 Dashboard:");
    console.log(`   https://dashboard.openfort.xyz/fee-sponsorships/${sponsorship.id}\n`);

    return { policy, sponsorship };
  } catch (error) {
    console.error("\n❌ Error:", error.message || error);
    if (error.errorMessage) {
      console.error("Details:", error.errorMessage);
    }
    process.exit(1);
  }
}

setup();
