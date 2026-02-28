#!/usr/bin/env node

/**
 * List all accounts using raw API
 */

import Openfort from "@openfort/openfort-node";

const secretKey = process.argv[2];
const walletSecret = process.argv[3];

async function listAccounts() {
  try {
    const openfort = new Openfort(secretKey, {
      walletSecret: walletSecret,
    });

    console.log("🔍 Listing all backend accounts...\n");

    // Try different methods
    console.log("Method 1: list()");
    const result1 = await openfort.accounts.evm.backend.list({ limit: 100 });
    console.log("Result type:", typeof result1);
    console.log("Is array:", Array.isArray(result1));
    console.log("Keys:", Object.keys(result1));
    console.log("Full result:", JSON.stringify(result1, null, 2));
  } catch (error) {
    console.error("Error:", error.message);
    if (error.response) {
      console.error("Response:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

listAccounts();
