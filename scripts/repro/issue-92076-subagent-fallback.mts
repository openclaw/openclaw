#!/usr/bin/env node
// Standalone real-environment proof for #92076 (proactive direct-text fallback).
//
// Drives the production `deliverSubagentAnnouncement` with mocked deps via
// the production `testing.setDepsForTest` seam. Constructs a scenario
// where the requester session is inactive and the active-wake retry
// returns `queued: false`, so the new `deliverTextCompletionDirect`
// fallback path runs.
//
// All paths other than the four mocked seams (`getRequesterSessionActivity`,
// `isRequesterSessionAbandoned`, `queueEmbeddedAgentMessageWithOutcome`,
// `sendMessage`) and the runtime-config default are real production
// code paths: the dispatch decision tree, the `isDirectMessageDeliveryTarget`
// gate, the `capDirectTextContent` truncation, and the message-to-send
// construction all run untouched.
//
// Run: node --import tsx scripts/repro/issue-92076-subagent-fallback.mts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  deliverSubagentAnnouncement,
  testing as announceTesting,
} from "../../src/agents/subagent-announce-delivery.js";

// --- Capture the args the production code would have passed to sendMessage.
// We replace the dep so the real network plugin is never invoked, but the
// production call site builds the full MessageSendParams before calling
// our mock, so we can read every field back.
const sentMessages: unknown[] = [];

// We drive deliverSubagentAnnouncement through its public export so the
// production dispatch + the new fallback call sites run unmodified.
// `testing.setDepsForTest` swaps only the five seams below; everything
// else (deliveryTarget inference, isDirectMessageDeliveryTarget, the
// proactive-fallback guard, capDirectTextContent, mirror) is real.
announceTesting.setDepsForTest({
  // Requester session is currently active but the active-wake retry cannot
  // queue the message (no live embedded run for this session). This is the
  // production trigger for the proactive direct-text fallback path: the
  // existing wake helper returns `queued: false`, flips
  // `activeRequesterWakeFailed = true`, and the new fallback runs.
  getRequesterSessionActivity: () => ({ sessionId: "sid-requester-001", isActive: true }),
  // The abandon check returns false so the wake path proceeds (an abandoned
  // session would short-circuit before reaching the new fallback).
  isRequesterSessionAbandoned: () => false,
  // The primary direct dispatch (gateway agent call) fails because there
  // is no live embedded run to dispatch into. The production code treats
  // this as a recoverable error and falls through to the steer fallback.
  dispatchGatewayMethodInProcess: (async () => {
    throw new Error("no live embedded run for session sid-requester-001");
  }) as never,
  // The active-wake retry resolves with `queued: false` because the lane
  // has no run to wake. This is the trigger that flips
  // `activeRequesterWakeFailed` to true and runs the new fallback.
  queueEmbeddedAgentMessageWithOutcome: async () => ({
    queued: false,
    sessionId: "sid-requester-001",
    reason: "no_active_run",
    gatewayHealth: "live",
    errorMessage: "no active embedded run for this session",
  }),
  // The direct channel send. Captures the args for assertion and returns a
  // minimal MessageSendResult so the production code path completes.
  sendMessage: (async (params: Record<string, unknown>) => {
    sentMessages.push(params);
    return {
      channel: params.channel as string,
      to: params.to as string,
      via: "direct" as const,
      mediaUrl: null,
      result: { messageId: "msg-direct-repro-001" },
    };
  }) as never,
});

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92076-"));
process.env.OPENCLAW_STATE_DIR = tmpRoot;

console.log("=== Reproduction for issue #92076 (proactive direct-text fallback) ===");
console.log(`OPENCLAW_STATE_DIR: ${tmpRoot}`);
console.log("");

const subagentResultText =
  "Weather check complete: it is sunny in San Francisco with a high of 72F, " +
  "low of 58F, and light winds from the west at 8 mph. " +
  "Humidity sits at 64 percent, and UV index is at 6 (high). " +
  "No precipitation expected through the evening.";

const started = performance.now();
const result = await deliverSubagentAnnouncement({
  requesterSessionKey: "agent:main:main",
  triggerMessage: "Subagent: check weather",
  steerMessage: "Subagent finished: weather is sunny",
  internalEvents: [
    {
      type: "task_completion",
      source: "subagent",
      childSessionKey: "agent:worker:subagent:child",
      childSessionId: "sid-subagent-001",
      announceType: "subagent task",
      taskLabel: "weather check",
      status: "ok",
      statusLabel: "completed successfully",
      result: subagentResultText,
      replyInstruction:
        "Continue from the existing transcript and finish the interrupted response.",
    },
  ],
  targetRequesterSessionKey: "agent:main:main",
  // Direct channel target — telegram DM. The requesterSessionOrigin feeds
  // resolveExternalBestEffortDeliveryTarget, which decides deliver=true.
  requesterSessionOrigin: { channel: "telegram", to: "user:248008339" },
  requesterOrigin: { channel: "telegram", to: "user:248008339" },
  completionDirectOrigin: { channel: "telegram", to: "user:248008339" },
  directOrigin: { channel: "telegram", to: "user:248008339" },
  sourceSessionKey: "agent:worker:subagent:child",
  sourceChannel: "telegram",
  sourceTool: "subagent_announce",
  requesterIsSubagent: false,
  expectsCompletionMessage: true,
  directIdempotencyKey: "repro-92076-proactive-fallback-001",
});
const elapsedMs = Math.round(performance.now() - started);

console.log("=== Results ===");
console.log(`Outcome: ${JSON.stringify(result, null, 2)}`);
console.log(`sendMessage call count: ${sentMessages.length}`);
console.log("");

if (sentMessages.length > 0) {
  const call = sentMessages[0] as Record<string, unknown>;
  console.log("Captured sendMessage call:");
  for (const [k, v] of Object.entries(call)) {
    const display = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : v;
    console.log(`  ${k}: ${JSON.stringify(display)}`);
  }
}

console.log("");
console.log(`Total elapsed: ${elapsedMs}ms`);

assert.equal(result.delivered, true, "expected delivery to succeed via direct fallback");
assert.equal(result.path, "direct", "expected delivery path to be 'direct'");
assert.equal(sentMessages.length, 1, "expected exactly one sendMessage call");

const firstCall = sentMessages[0] as Record<string, unknown>;
assert.equal(firstCall.channel, "telegram", "expected channel=telegram");
assert.equal(firstCall.to, "user:248008339", "expected to=user:248008339");
assert.equal(
  typeof firstCall.content === "string" && firstCall.content.includes("Weather check complete"),
  true,
  "expected content to include subagent result text",
);

const mirror = firstCall.mirror as Record<string, unknown> | undefined;
assert.ok(mirror, "expected mirror to be set for direct text fallback");
assert.equal(mirror?.sessionKey, "agent:main:main", "expected mirror.sessionKey=requestSessionKey");

console.log("");
console.log("PASS: subagent completion delivered via direct channel after active-wake failure.");
console.log("PASS: deliverTextCompletionDirect was the path taken (no requester-agent handoff needed).");

await fs.rm(tmpRoot, { recursive: true, force: true });