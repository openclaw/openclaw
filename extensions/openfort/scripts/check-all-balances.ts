#!/usr/bin/env node

import Openfort from "@openfort/openfort-node";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];

async function checkAll() {
  const openfort = new Openfort(secretKey, { walletSecret });
  const result = await openfort.accounts.evm.backend.list({ limit: 100 });
  const accounts = result.accounts || [];

  console.log(`💰 Checking balances for ${accounts.length} wallet(s)...\n`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  for (const account of accounts) {
    const balance = await publicClient.getBalance({ address: account.address });
    const balanceEth = (Number(balance) / 1e18).toFixed(6);

    console.log(`📍 ${account.address}`);
    console.log(`   Balance: ${balanceEth} ETH`);
    if (Number(balance) > 0) {
      console.log(`   ✅ HAS FUNDS!`);
    }
    console.log("");
  }
}

checkAll();
