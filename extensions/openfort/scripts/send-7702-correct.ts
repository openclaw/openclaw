#!/usr/bin/env node

/**
 * Send USDC using EIP-7702 Delegated Account
 * Based on working Openfort sample
 */

import Openfort from "@openfort/openfort-node";
import { createPublicClient, http, isAddress, type Hex, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { hashAuthorization } from "viem/utils";

const secretKey: string = process.argv[2];
const walletSecret: string = process.argv[3];
const recipientInput: string = process.argv[4] || "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const amountUsdc: string = process.argv[5] || "0.5";

// Validate recipient address
if (!isAddress(recipientInput)) {
  console.error(`❌ Invalid recipient address: ${recipientInput}`);
  process.exit(1);
}
const recipient: Address = recipientInput;

const BASE_SEPOLIA_CHAIN_ID: number = 84532;
const USDC_CONTRACT_ID: string = "con_5fdc62b6-8c50-495c-8f43-bdb765ee24ed";
const DELEGATED_ACCOUNT_ID: string = "acc_ab6ff7c9-f950-40e5-91ff-0ae523295783";
const EOA_ACCOUNT_ID: string = "acc_c9ccf722-01e3-453a-8b18-b535abb22cd2";
const IMPLEMENTATION_ADDRESS: Hex = "0x000000009b1d0af20d8c6d0a44e162d11f9b8f00";

console.log("🚀 Sending USDC via EIP-7702 Delegated Account\n");

async function sendUSDC() {
  try {
    const openfort = new Openfort(secretKey, { walletSecret });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });

    // Step 1: Get EOA account
    console.log("1️⃣  Getting EOA account...");
    const eoaAccount = await openfort.accounts.evm.backend.get({ id: EOA_ACCOUNT_ID });
    console.log(`✅ Account: ${eoaAccount.address}`);
    console.log(`   ID: ${eoaAccount.id}`);

    // Check if delegation is active
    const code = await publicClient.getBytecode({ address: eoaAccount.address });
    const needsAuth = !code;
    console.log(`   Has code: ${code ? "YES" : "NO"}`);
    console.log(`   Needs authorization: ${needsAuth ? "YES" : "NO"}\n`);

    let authSignature = undefined;

    // Step 2: Create signedAuthorization if needed
    if (needsAuth) {
      console.log("2️⃣  Creating EIP-7702 authorization...");
      console.log(`   Implementation: ${IMPLEMENTATION_ADDRESS}`);
      console.log(`   Chain ID: ${BASE_SEPOLIA_CHAIN_ID}`);

      // Get EOA nonce
      const eoaNonce = await publicClient.getTransactionCount({
        address: eoaAccount.address,
      });
      console.log(`   EOA nonce: ${eoaNonce}`);

      // Hash the authorization using viem
      const authHash = hashAuthorization({
        contractAddress: IMPLEMENTATION_ADDRESS,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        nonce: eoaNonce,
      });

      console.log(`   Auth hash: ${authHash}`);

      // Sign using account.sign({ hash })
      authSignature = await eoaAccount.sign({ hash: authHash });
      console.log(`   Signature: ${authSignature.substring(0, 20)}...\n`);
    }

    // Step 3: Create transaction intent
    const usdcAmount = Math.floor(parseFloat(amountUsdc) * 1e6);

    console.log(`${needsAuth ? "3️⃣" : "2️⃣"}  Creating transaction intent...`);
    console.log(`   From: ${eoaAccount.address}`);
    console.log(`   To: ${recipient}`);
    console.log(`   Amount: ${amountUsdc} USDC\n`);

    const intentParams = {
      account: DELEGATED_ACCOUNT_ID,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      optimistic: false,
      interactions: [
        {
          contract: USDC_CONTRACT_ID,
          functionName: "transfer",
          functionArgs: [recipient, usdcAmount.toString()],
        },
      ],
    };

    // Add signedAuthorization if delegation not active
    if (needsAuth && authSignature) {
      intentParams.signedAuthorization = authSignature;
    }

    let intent = await openfort.transactionIntents.create(intentParams);

    console.log("✅ Transaction intent created!");
    console.log(`   Intent ID: ${intent.id}`);
    console.log(`   Factory: ${intent.details?.userOperation?.factory}\n`);

    // Step 4: Sign user operation if needed
    if (intent.nextAction?.type === "sign_with_wallet") {
      console.log(`${needsAuth ? "4️⃣" : "3️⃣"}  Signing user operation...`);
      const signableHash = intent.nextAction.payload.signableHash;
      console.log(`   Hash: ${signableHash}`);

      // Sign using account.sign({ hash })
      const txSignature = await eoaAccount.sign({ hash: signableHash });
      console.log(`   Signature: ${txSignature.substring(0, 20)}...\n`);

      console.log(`${needsAuth ? "5️⃣" : "4️⃣"}  Submitting transaction...`);
      intent = await openfort.transactionIntents.signature(intent.id, {
        signature: txSignature,
      });

      console.log("✅ Transaction submitted!");
    }

    // Step 5: Wait for confirmation
    if (intent.response?.transactionHash) {
      console.log(`   Hash: ${intent.response.transactionHash}`);
      console.log(
        `   Explorer: https://sepolia.basescan.org/tx/${intent.response.transactionHash}\n`,
      );

      console.log(`${needsAuth ? "6️⃣" : "5️⃣"}  Waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: intent.response.transactionHash,
        timeout: 60000,
      });

      console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
      console.log(`   Status: ${receipt.status === "success" ? "✅ Success" : "❌ Failed"}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);
    } else {
      console.log("📋 Intent response:");
      console.log(JSON.stringify(intent, null, 2));
    }

    console.log("💰 Transaction Summary:");
    console.log("   - EIP-7702 Delegation: ✅");
    console.log("   - Implementation: Calibur");
    console.log("   - Gas Payment: USDC (dynamic)");
    console.log("   - Policy: pol_47d0895b-80a2-48c5-a709-d3ccb95dccee");
    console.log(
      `   - Authorization: ${needsAuth ? "Included" : "Not needed (already delegated)"}\n`,
    );

    console.log("🎉 USDC sent successfully via EIP-7702!");

    return intent;
  } catch (error) {
    console.error("\n❌ Error:", error.message || error);
    if (error.errorMessage) {
      console.error("Details:", JSON.stringify(error.errorMessage, null, 2));
    }
    if (error.response) {
      console.error("Response:", JSON.stringify(error.response, null, 2));
    }
    if (error.stack) {
      console.error("\nStack:", error.stack);
    }
    process.exit(1);
  }
}

sendUSDC();
