/**
 * AgentMail Gateway Service Tests
 *
 * Tests validate:
 * - Secrets loading and validation
 * - Configuration loading
 * - Rate limiting
 * - Recipient allowlisting
 * - Email sending (mock)
 * - Logging
 */

import { sendEmail, readAgentInbox, getVerificationLinks, healthCheck, logActivity } from './agentmail-gateway.js';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTest(name, testFn) {
  try {
    await testFn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}: ${error.message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('Running AgentMail Gateway Tests...\n');

  // Test 1: Health Check
  await runTest('Health Check - Gateway should be healthy', () => {
    const health = healthCheck();
    assert(health.status === 'healthy', `Expected healthy, got ${health.status}`);
    assert(health.timestamp, 'Should have timestamp');
  });

  // Test 2: Secrets Loading
  await runTest('Secrets Loading - Should load required keys', () => {
    // This will throw if secrets are missing
    healthCheck();
  });

  // Test 3: Reject non-allowlisted recipient
  await runTest('Allowlist - Should reject non-allowlisted recipients', async () => {
    try {
      await sendEmail('unknown@example.com', 'Test', 'Test body');
      throw new Error('Should have rejected non-allowlisted email');
    } catch (error) {
      assert(
        error.message.includes('not in allowlist'),
        `Expected allowlist error, got: ${error.message}`,
      );
    }
  });

  // Test 4: Accept allowlisted recipient
  await runTest('Send Email - Should accept allowlisted recipient', async () => {
    const result = await sendEmail(
      'fjventura20@gmail.com',
      'Test Email 1',
      'This is a test body 1',
    );
    assert(result.status === 'success', `Expected success, got ${result.status}`);
    assert(result.message, 'Should have success message');
  });

  // Test 5: Read Inbox
  await runTest('Inbox - Should read inbox successfully', async () => {
    const result = await readAgentInbox();
    assert(result.status === 'success', `Expected success, got ${result.status}`);
    assert(Array.isArray(result.inbox), 'Should return inbox array');
  });

  // Test 6: Get Verification Links
  await runTest('Verification Links - Should extract links', async () => {
    const result = await getVerificationLinks();
    assert(result.status === 'success', `Expected success, got ${result.status}`);
    assert(Array.isArray(result.links), 'Should return links array');
  });

  // Test 7: Logging
  await runTest('Logging - Should log activities without error', () => {
    logActivity('test_action', { testKey: 'testValue' });
  });

  // Test 8: Rate Limiting
  await runTest('Rate Limiting - Should enforce hourly limit', async () => {
    // Try to send 4 more emails (we already sent 1, so 5 total = hourly limit)
    for (let i = 2; i <= 5; i++) {
      await sendEmail(
        'fjventura20@gmail.com',
        `Test Email ${i}`,
        `Body ${i}`,
      );
    }

    // 6th should fail
    try {
      await sendEmail(
        'fjventura20@gmail.com',
        'Test Email 6',
        'Body 6',
      );
      throw new Error('Should have hit hourly rate limit');
    } catch (error) {
      assert(
        error.message.includes('rate limit'),
        `Expected rate limit error, got: ${error.message}`,
      );
    }
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Tests Complete: ${testsPassed} passed, ${testsFailed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
