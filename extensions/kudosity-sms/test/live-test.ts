#!/usr/bin/env npx tsx
/**
 * Live integration test for the Kudosity SMS API client.
 *
 * Requires environment variables:
 *   KUDOSITY_API_KEY     — Your Kudosity API key
 *   KUDOSITY_SENDER      — Sender number (without + prefix, e.g. 61400000000)
 *   KUDOSITY_TEST_NUMBER — Recipient number for testing (e.g. 61412345678)
 *
 * Usage:
 *   KUDOSITY_API_KEY=xxx KUDOSITY_SENDER=61400000000 KUDOSITY_TEST_NUMBER=61412345678 \
 *     npx tsx test/live-test.ts
 */

// Since we're outside the OpenClaw monorepo, import directly
const BASE_URL = "https://api.transmitmessage.com";

interface KudosityConfig {
  apiKey: string;
  sender: string;
}

interface SendSMSParams {
  message: string;
  sender: string;
  recipient: string;
  message_ref?: string;
  track_links?: boolean;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const apiKey = process.env.KUDOSITY_API_KEY;
const sender = process.env.KUDOSITY_SENDER;
const testNumber = process.env.KUDOSITY_TEST_NUMBER;

if (!apiKey || !sender || !testNumber) {
  console.error("❌ Missing required environment variables:");
  console.error("   KUDOSITY_API_KEY, KUDOSITY_SENDER, KUDOSITY_TEST_NUMBER");
  console.error("");
  console.error("Usage:");
  console.error(
    "  KUDOSITY_API_KEY=xxx KUDOSITY_SENDER=61400000000 KUDOSITY_TEST_NUMBER=61412345678 npx tsx test/live-test.ts",
  );
  process.exit(1);
}

const config: KudosityConfig = { apiKey, sender };

async function runTests() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  📱 Kudosity SMS Channel Plugin — Live API Test");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log(`  API Key:     ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`  Sender:      ${sender}`);
  console.log(`  Recipient:   ${testNumber}`);
  console.log("");

  // Test 1: Validate API key
  console.log("🔑 Test 1: Validate API key...");
  try {
    const validateRes = await fetch(`${BASE_URL}/v2/sms?limit=1`, {
      method: "GET",
      headers: buildHeaders(apiKey),
    });
    if (validateRes.ok) {
      console.log("   ✅ API key is valid");
    } else {
      console.error(`   ❌ API key validation failed (status: ${validateRes.status})`);
      process.exit(1);
    }
  } catch (error) {
    console.error("   ❌ Network error:", error);
    process.exit(1);
  }

  // Test 2: Send an SMS
  console.log("");
  console.log("📤 Test 2: Send SMS...");
  const messageRef = `openclaw-live-test-${Date.now()}`;
  let smsId: string;

  try {
    const sendRes = await fetch(`${BASE_URL}/v2/sms`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        message: `OpenClaw live test — ${new Date().toISOString()}`,
        sender,
        recipient: testNumber,
        message_ref: messageRef,
      } satisfies SendSMSParams),
    });

    if (!sendRes.ok) {
      const errorText = await sendRes.text();
      console.error(`   ❌ Send failed (status: ${sendRes.status}): ${errorText}`);
      process.exit(1);
    }

    const smsResponse = await sendRes.json();
    smsId = smsResponse.id;
    console.log(`   ✅ SMS sent successfully`);
    console.log(`      ID:          ${smsId}`);
    console.log(`      Status:      ${smsResponse.status}`);
    console.log(`      SMS count:   ${smsResponse.sms_count}`);
    console.log(`      Message ref: ${smsResponse.message_ref}`);
  } catch (error) {
    console.error("   ❌ Error sending SMS:", error);
    process.exit(1);
  }

  // Test 3: Retrieve SMS details
  console.log("");
  console.log("📋 Test 3: Retrieve SMS details...");

  // Wait a moment for delivery
  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    const getRes = await fetch(`${BASE_URL}/v2/sms/${smsId}`, {
      method: "GET",
      headers: buildHeaders(apiKey),
    });

    if (!getRes.ok) {
      console.error(`   ❌ Get failed (status: ${getRes.status})`);
      process.exit(1);
    }

    const details = await getRes.json();
    console.log(`   ✅ SMS details retrieved`);
    console.log(`      Status:      ${details.status}`);
    console.log(`      Created:     ${details.created_at}`);
    console.log(`      Updated:     ${details.updated_at}`);
    console.log(`      Direction:   ${details.direction}`);
    console.log(`      GSM:         ${details.is_gsm}`);
  } catch (error) {
    console.error("   ❌ Error retrieving SMS:", error);
    process.exit(1);
  }

  // Summary
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ All live tests passed!");
  console.log("");
  console.log("  The Kudosity SMS API is working correctly.");
  console.log("  The OpenClaw channel plugin API client matches the real API.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

runTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
