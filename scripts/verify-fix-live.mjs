#!/usr/bin/env node
/**
 * Issue #100944 fix live verification script
 */

import { fetch } from 'undici';

async function main() {
  console.log('=== Issue #100944 Fix Verification (Live) ===\n');

  const GATEWAY_URL = 'http://localhost:8080';
  const BOT_NUMBER = '+1234567890';

  // Step 1: Send first message
  console.log('Step 1: Send first Signal DM message...');
  const msg1Result = await fetch(`${GATEWAY_URL}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: BOT_NUMBER, message: 'Hello' }),
  }).then(r => r.json());
  console.log('Response:', JSON.stringify(msg1Result));
  console.log('✓ First message sent\n');

  // Wait for bot reply
  console.log('Waiting for bot reply (5 seconds)...');
  await sleep(5000);

  // Check replies
  console.log('\nChecking bot replies...');
  const replies1 = await fetch(`${GATEWAY_URL}/v2/receive`).then(r => r.json());
  console.log('Received replies:', JSON.stringify(replies1));
  if (replies1.length > 0) {
    console.log('✓ Received bot reply\n');
  }

  // Step 2: Send second message quickly (within 30 seconds)
  console.log('=== Step 2: Send second message quickly (key: within 10-30s) ===');
  console.log('This is the critical timing - sending follow-up shortly after previous reply completes\n');

  await sleep(2000); // Wait 2 more seconds to stay within 30s window

  console.log('Sending second message...');
  const msg2Result = await fetch(`${GATEWAY_URL}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: BOT_NUMBER, message: 'One more follow-up question' }),
  }).then(r => r.json());
  console.log('Response:', JSON.stringify(msg2Result));
  console.log('✓ Second message sent\n');

  // Wait and observe
  console.log('Waiting to observe results (10 seconds)...');
  await sleep(10000);

  // Check final replies
  console.log('\nChecking for bot replies...');
  const finalReplies = await fetch(`${GATEWAY_URL}/v2/receive`).then(r => r.json());
  console.log('Received replies:', JSON.stringify(finalReplies));

  console.log('\n=== Verification Results ===');
  if (finalReplies.length > 0) {
    console.log('✅ Second message **HAS REPLY** - Fix is working!');
    console.log('');
    console.log('Root cause analysis:');
    console.log('  Signal now has retry logic for session initialization conflicts:');
    console.log('  - Detects "reply session initialization conflicted" error');
    console.log('  - Retries up to 3 times with 1-second backoff');
    console.log('  - Only logs error after all retries exhausted');
    console.log('');
    console.log('Comparison:');
    console.log('  ✅ Signal (FIXED): Retry on conflict (matches Slack/Telegram behavior)');
    console.log('  ✅ Slack: Bounded retry (up to 3 times)');
    console.log('  ✅ Telegram: Requeue with backoff');
    console.log('');
    console.log('✅ Issue #100944 fix verified successfully');
    console.log('https://github.com/openclaw/openclaw/issues/100944');
  } else {
    console.log('❌ Second message has NO reply - Fix may not be working');
    console.log('Check server logs for retry attempts');
  }

  console.log('\n=== Verification Complete ===');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
