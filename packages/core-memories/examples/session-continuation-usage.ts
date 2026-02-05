/**
 * Usage Example: Session Continuation with CoreMemories
 *
 * This shows how to integrate session continuation into OpenClaw
 */

/* eslint-disable no-unused-vars */

import { CoreMemories, FlashEntry } from "../src/index";
import { onSessionStart, heartbeatSessionCheck } from "../src/session-continuation-integration";

// ============================================================================
// EXAMPLE 1: On Gateway/Session Start
// ============================================================================
async function onGatewayOpen() {
  const cm = new CoreMemories();
  await cm.initialize();

  // Check if we should continue previous session
  await onSessionStart(cm, (message: string) => {
    console.log(message);
    // In real implementation:
    // slack.send({ channel: userSlackChannel, message })
  });
}

// Example outputs based on gap:
// Gap < 2h: (nothing - silent)
// Gap 2-6h: "👋 Hey! Still working on the Card Sync launch?"
// Gap 6h+: "👋 Welcome back! **Last time we were working on:** ..."

// ============================================================================
// EXAMPLE 2: HEARTBEAT Integration
// ============================================================================
async function onHeartbeat() {
  const cm = new CoreMemories();
  await cm.initialize();

  await heartbeatSessionCheck(cm);
}

// ============================================================================
// EXAMPLE 3: User Says "Continue"
// ============================================================================
async function onUserContinues(topic: string): Promise<string | undefined> {
  const cm = new CoreMemories();
  await cm.initialize();

  const results = cm.findByKeyword(topic);
  const allResults = [...results.flash, ...results.warm];

  if (allResults.length > 0) {
    const context = allResults
      .slice(0, 3)
      .map((m) => {
        if ("content" in m && typeof m.content === "string") {
          return m.content;
        }
        return "";
      })
      .filter((c) => c.length > 0)
      .join("\n---\n");

    return `Previous context on "${topic}": ${context}\nUser wants to continue from here.`;
  }

  return undefined;
}

// ============================================================================
// EXAMPLE 4: User Says "Start Fresh"
// ============================================================================
async function onUserStartsFresh() {
  const cm = new CoreMemories();
  await cm.initialize();

  cm.addFlashEntry(
    "User chose to start fresh rather than continue previous context",
    "user",
    "decision",
  );
}

// ============================================================================
// EXAMPLE 5: Configuration
// ============================================================================
const CONFIG = {
  sessionContinuation: {
    enabled: true,
    thresholds: { silent: 2, hint: 6, prompt: 24 },
    prioritizeFlagged: true,
    maxMemoriesToShow: 3,
  },
};

// ============================================================================
// EXAMPLE 6: Testing the Integration
// ============================================================================
async function testSessionContinuation(): Promise<void> {
  const testCases = [
    { gap: 1, expectedMode: "silent" },
    { gap: 3, expectedMode: "hint" },
    { gap: 8, expectedMode: "prompt" },
    { gap: 30, expectedMode: "prompt" },
  ];

  const cm = new CoreMemories();
  await cm.initialize();

  for (const tc of testCases) {
    const lastSession = Date.now() - tc.gap * 60 * 60 * 1000;
    // onSessionStart returns void - check side effects
    await onSessionStart(cm, (msg: string) => {
      console.log(`Gap ${tc.gap}h: ${msg || "(no message)"}`);
      return;
    });
  }
}

// Export for testing
export { onGatewayOpen, onHeartbeat, onUserContinues, onUserStartsFresh, testSessionContinuation };
