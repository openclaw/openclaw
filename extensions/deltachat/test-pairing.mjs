#!/usr/bin/env node

/**
 * Test script for Delta.Chat pairing functionality
 *
 * This script tests the QR code generation feature
 * without requiring the full OpenClaw runtime.
 */

import { generatePairingQrCode } from "./src/pairing.ts";

async function testPairing() {
  console.log("🧪 Testing Delta.Chat Pairing QR Code Generation\n");

  try {
    // Test 1: Generate QR code with terminal output
    console.log("Test 1: Generate QR code (terminal output)");
    const result1 = await generatePairingQrCode({
      accountId: "default",
      output: "terminal",
      format: "text",
    });

    if (result1.ok) {
      console.log("✅ QR code generated successfully");
      console.log("\nQR Data:", result1.qrCodeData);
    } else {
      console.log("❌ Error:", result1.error);
    }

    console.log("\n" + "=".repeat(60) + "\n");

    // Test 2: Generate QR code with file output
    console.log("Test 2: Generate QR code (file output)");
    const result2 = await generatePairingQrCode({
      accountId: "default",
      output: "/tmp/delta-chat-test.qr",
      format: "text",
    });

    if (result2.ok) {
      console.log("✅ QR code generated and saved to file");
      console.log("File path:", result2.filePath);
      console.log("QR Data:", result2.qrCodeData);
    } else {
      console.log("❌ Error:", result2.error);
    }

    console.log("\n" + "=".repeat(60) + "\n");

    // Test 3: Test with environment variables
    console.log("Test 3: Test with environment variables");
    process.env.DELTACHAT_ADDR = "test@example.com";
    process.env.DELTACHAT_MAIL_PW = "test-password";

    const result3 = await generatePairingQrCode({
      accountId: "default",
      output: "terminal",
      format: "text",
    });

    if (result3.ok) {
      console.log("✅ QR code generated with env vars");
      console.log("QR Data:", result3.qrCodeData);
    } else {
      console.log("❌ Error:", result3.error);
    }

    console.log("\n" + "=".repeat(60) + "\n");
    console.log("🧪 All tests completed");
  } catch (err) {
    console.error("❌ Test failed with error:", err);
    process.exit(1);
  }
}

// Run tests
testPairing().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
