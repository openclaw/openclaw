import { EventEmitter } from "node:events";
// Telegram polling crash recovery test
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  acquireTelegramPollingLease,
  releaseStoppedTelegramPollingLease,
  resetTelegramPollingLeasesForTests,
} from "../src/polling-lease.js";
import { fingerprintTelegramBotToken } from "../src/token-fingerprint.js";

describe("Telegram polling crash recovery", () => {
  const testToken = "test-bot-token-12345";
  const testAccountId = "test-account";
  const tokenFingerprint = fingerprintTelegramBotToken(testToken);

  beforeEach(() => {
    resetTelegramPollingLeasesForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetTelegramPollingLeasesForTests();
  });

  it("should detect and replace stale lease after crash", async () => {
    // Simulate a crash scenario: acquire lease, mark as aborted, wait for staleness threshold
    const abortController = new AbortController();

    // Acquire initial lease
    const lease1 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      abortSignal: abortController.signal,
    });

    expect(lease1.tokenFingerprint).toBe(tokenFingerprint);
    expect(lease1.waitedForPrevious).toBe(false);

    // Simulate crash: abort the signal
    abortController.abort();

    // Don't release the lease - simulate crash where lease is left in aborted state
    // lease1.release(); // Commented out to simulate crash

    // Verify lease is still in registry but aborted
    // Now try to acquire a new lease - should replace the stale one
    const lease2 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      waitMs: 100, // Short wait for testing
    });

    expect(lease2.tokenFingerprint).toBe(tokenFingerprint);
    expect(lease2.replacedStoppingPrevious).toBe(true);

    lease2.release();
  });

  it("should wait for healthy lease to complete naturally", async () => {
    const abortController1 = new AbortController();
    const abortController2 = new AbortController();

    // Acquire first lease
    const lease1 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      abortSignal: abortController1.signal,
    });

    // Try to acquire second lease while first is still active - should fail
    await expect(
      acquireTelegramPollingLease({
        token: testToken,
        accountId: testAccountId,
        abortSignal: abortController2.signal,
      }),
    ).rejects.toThrow(/Telegram polling already active/);

    // Release first lease normally
    lease1.release();

    // Now second lease should succeed
    const lease2 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      abortSignal: abortController2.signal,
    });

    expect(lease2).toBeDefined();
    lease2.release();
  });

  it("should replace stale aborting lease after timeout", async () => {
    const abortController1 = new AbortController();

    // Acquire first lease
    const lease1 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      abortSignal: abortController1.signal,
    });

    // Abort the first lease (simulating crash)
    abortController1.abort();

    // Try to acquire second lease with short wait - should replace stale lease
    const lease2 = await acquireTelegramPollingLease({
      token: testToken,
      accountId: testAccountId,
      waitMs: 100, // Short wait for testing
    });

    expect(lease2.replacedStoppingPrevious).toBe(true);

    lease2.release();
  });

  it("should provide detailed error message for duplicate polling", () => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const abortController1 = new AbortController();
        const abortController2 = new AbortController();

        // Acquire first lease
        const lease1 = await acquireTelegramPollingLease({
          token: testToken,
          accountId: testAccountId,
          abortSignal: abortController1.signal,
        });

        // Try to acquire second lease without aborting first
        try {
          await acquireTelegramPollingLease({
            token: testToken,
            accountId: `${testAccountId}-duplicate`,
            abortSignal: abortController2.signal,
          });
          reject(new Error("Should have thrown for duplicate polling"));
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          expect(errorMessage).toContain("Telegram polling already active");
          expect(errorMessage).toContain(tokenFingerprint);
          expect(errorMessage).toContain(testAccountId);
          resolve();
        } finally {
          lease1.release();
        }
      } catch (err) {
        reject(err);
      }
    });
  });
});
