#!/usr/bin/env node

import Openfort from "@openfort/openfort-node";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];

async function listPolicies() {
  const openfort = new Openfort(secretKey, { walletSecret });

  console.log("📋 Listing all policies...\n");

  const policies = await openfort.policies.list({ limit: 100 });

  console.log(`Found ${policies.data?.length || 0} policies:\n`);

  if (policies.data) {
    policies.data.forEach((p, i) => {
      console.log(`${i + 1}. ${p.name || "Unnamed"}`);
      console.log(`   ID: ${p.id}`);
      console.log(`   Chain: ${p.chainId}`);
      console.log(`   Enabled: ${p.enabled}`);
      console.log(`   Strategy: ${p.strategy?.sponsorSchema || "N/A"}`);
      console.log("");
    });
  }
}

listPolicies().catch(console.error);
