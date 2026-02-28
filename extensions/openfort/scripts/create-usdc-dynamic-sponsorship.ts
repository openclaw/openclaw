#!/usr/bin/env node

/**
 * Create fee sponsorship with charge_custom_tokens (dynamic USDC)
 * Then delete the old pay_for_user sponsorship
 */

import Openfort from "@openfort/openfort-node";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];

const BASE_SEPOLIA_CHAIN_ID = 84532;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const OLD_SPONSORSHIP_ID = "pol_d90bcf71-2b38-4bb3-ae36-a5da6cef10f5";

console.log("⚙️  Creating USDC Dynamic Fee Sponsorship\n");

async function setup() {
  try {
    const openfort = new Openfort(secretKey, { walletSecret });

    // Step 1: Get or create USDC contract
    console.log("1️⃣  Checking USDC contract registration...");
    const contracts = await openfort.contracts.list({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      limit: 100,
    });

    let usdcContract = contracts.data?.find(
      (c) => c.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase(),
    );

    if (!usdcContract) {
      console.log("   Registering USDC contract...");
      usdcContract = await openfort.contracts.create({
        name: "USDC (Base Sepolia)",
        chainId: BASE_SEPOLIA_CHAIN_ID,
        address: USDC_BASE_SEPOLIA,
      });
      console.log(`   ✅ Registered: ${usdcContract.id}\n`);
    } else {
      console.log(`   ✅ Already registered: ${usdcContract.id}\n`);
    }

    // Step 2: Create policy
    console.log("2️⃣  Creating policy...");
    const policy = await openfort.policies.create({
      scope: "project",
      description: "Sponsor Base Sepolia transactions with dynamic USDC",
      rules: [
        {
          action: "accept",
          operation: "sponsorEvmTransaction",
          criteria: [{ type: "evmNetwork", operator: "in", chainIds: [BASE_SEPOLIA_CHAIN_ID] }],
        },
      ],
    });
    console.log(`   ✅ Created policy: ${policy.id}\n`);

    // Step 3: Create fee sponsorship with charge_custom_tokens (dynamic)
    console.log("3️⃣  Creating fee sponsorship with dynamic USDC...");
    console.log("   Strategy: charge_custom_tokens (dynamic rate)");
    console.log("   Token: USDC (auto-calculated gas cost)\n");

    const sponsorship = await openfort.feeSponsorship.create({
      name: "Dynamic USDC Gas Payment - Base Sepolia",
      policyId: policy.id,
      strategy: {
        sponsorSchema: "charge_custom_tokens",
        tokenContract: usdcContract.id,
        // NOT setting tokenContractAmount = dynamic calculation
      },
    });

    console.log("   ✅ Created fee sponsorship!");
    console.log(`      ID: ${sponsorship.id}`);
    console.log(`      Name: ${sponsorship.name}`);
    console.log(`      Strategy: ${sponsorship.strategy.sponsorSchema}`);
    console.log(`      Token: ${sponsorship.strategy.tokenContract}`);
    console.log(`      Policy: ${sponsorship.policyId}\n`);

    // Step 4: Delete old sponsorship
    console.log("4️⃣  Deleting old pay_for_user sponsorship...");
    console.log(`   ID: ${OLD_SPONSORSHIP_ID}\n`);

    await openfort.feeSponsorship.delete(OLD_SPONSORSHIP_ID);

    console.log("   ✅ Deleted!\n");

    // Verify
    console.log("5️⃣  Verifying setup...");
    const remaining = await openfort.feeSponsorship.list({ limit: 100 });

    console.log(`   Total fee sponsorships: ${remaining.data?.length || 0}\n`);

    if (remaining.data) {
      remaining.data.forEach((s) => {
        console.log(`   ✅ ${s.id}`);
        console.log(`      Name: ${s.name}`);
        console.log(`      Strategy: ${s.strategy.sponsorSchema}`);
        console.log("");
      });
    }

    console.log("🎉 Setup Complete!\n");

    console.log("📋 How it works:");
    console.log("   - User sends transaction on Base Sepolia");
    console.log("   - Gas cost is calculated dynamically");
    console.log("   - Equivalent USDC is charged from user wallet");
    console.log("   - Openfort paymaster pays ETH gas fees");
    console.log("   - User only needs USDC, no ETH! ✅\n");

    console.log("🔗 Dashboard:");
    console.log(`   https://dashboard.openfort.xyz/fee-sponsorships/${sponsorship.id}\n`);

    return { policy, sponsorship };
  } catch (error) {
    console.error("\n❌ Error:", error.message || error);
    if (error.errorMessage) {
      console.error("Details:", JSON.stringify(error.errorMessage, null, 2));
    }
    process.exit(1);
  }
}

setup();
