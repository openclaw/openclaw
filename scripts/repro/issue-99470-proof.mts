/**
 * Real Behavior Proof for #99470 — delivery-mirror prompt contamination.
 *
 * Two-layer defence:
 *   Layer 1 (identity fallback): isTranscriptOnlyOpenClawAssistantMessage now
 *     checks openclawDeliveryMirror field for stripped-metadata survivors.
 *   Layer 2 (adjacent dedup): normalizeAssistantReplayContent collapses
 *     byte-identical adjacent no-tool assistant duplicates.
 *
 * This script exercises the full replay path: simulate a session rebuild
 * transcript → run through normalizeAssistantReplayContent (called by both
 * sanitizeSessionHistory and normalizeMessagesForLlmBoundary) → verify the
 * provider-bound prompt is clean.
 *
 * Usage: node --import tsx scripts/repro/issue-99470-proof.mts
 */
import { normalizeAssistantReplayContent } from "../../src/agents/embedded-agent-runner/replay-history.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../src/shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function assistant(content: unknown, extra?: Record<string, unknown>): AgentMessage {
  return {
    role: "assistant",
    content,
    usage: { input: 10, output: 20, totalTokens: 30 },
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  } as unknown as AgentMessage;
}

function toolResult(toolUseId: string, text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function strippedMirror(text: string): AgentMessage {
  // Metadata-stripped delivery-mirror survivor (#99470): provider/model/usage
  // stripped by session rebuild / side-branch merge, but openclawDeliveryMirror
  // survives serialization.
  return assistant([{ type: "text", text }], {
    openclawDeliveryMirror: { kind: "channel-final" },
    usage: { input: 0, output: 0, totalTokens: 0 },
  });
}

function liveMirror(text: string): AgentMessage {
  // Live delivery-mirror entry before metadata is stripped — has provider/model
  return assistant([{ type: "text", text }], {
    provider: "openclaw",
    model: "delivery-mirror",
    usage: { input: 0, output: 0, totalTokens: 0 },
  });
}

function bareDuplicate(text: string, usage?: { input: number; output: number; totalTokens: number }): AgentMessage {
  // Truly marker-free duplicate (#99470 P1): after session rebuild/side-branch
  // merge, the delivery-mirror entry loses provider, model, AND
  // openclawDeliveryMirror — leaving only { role, content, usage }.
  // Layer 1 (identity fallback) CANNOT see this; only Layer 2 (adjacent dedup)
  // can collapse it.
  return assistant([{ type: "text", text }], {
    usage: usage ?? { input: 0, output: 0, totalTokens: 0 },
  });
}

function nativeToolUseTurn(text: string, toolUseId: string, toolName: string): AgentMessage {
  return assistant(
    [
      { type: "text", text },
      { type: "tool_use", id: toolUseId, name: toolName, input: {} },
    ],
    { stopReason: "tool_use", usage: { input: 50, output: 30, totalTokens: 80 } },
  );
}

let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failures++;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Case 0 — Full Session Rebuild Contamination Path
// ══════════════════════════════════════════════════════════════════════════
// Simulates buildSessionContext() output after a session rebuild / side-branch
// merge. Contains THREE types of delivery-mirror survivors that must all be
// filtered before the provider sees them:
//   live  — {provider:"openclaw", model:"delivery-mirror"} — Layer 1 (existing main filter)
//   stripped — {openclawDeliveryMirror:{...}} — Layer 1b (identity fallback, new)
//   bare  — {role,content,usage} only, no marker at all — Layer 2 (adjacent dedup, new)
// The bare duplicates are the P1 proof gap: without the marker, ONLY content-
// based adjacent dedup can collapse them.
console.log("═".repeat(64));
console.log("Case 0 — Session rebuild contamination path (all 3 mirror types)");
console.log("═".repeat(64));

const rebuildSessionContext: AgentMessage[] = [
  user("Find the error in the logs"),
  nativeToolUseTurn("Let me check the server logs.", "toolu_001", "read"),
  toolResult("toolu_001", "ERROR: connection timeout at 14:32:15"),
  assistant([{ type: "text", text: "I found a connection timeout error at 14:32:15. Let me investigate the cause." }]),
  liveMirror("I found a connection timeout error at 14:32:15. Let me investigate the cause."),
  strippedMirror("I found a connection timeout error at 14:32:15. Let me investigate the cause."),
  // P1 — truly marker-free duplicate: no provider, no model, no openclawDeliveryMirror.
  // Only Layer 2 (byte-identical adjacent content dedup) can remove this.
  bareDuplicate("I found a connection timeout error at 14:32:15. Let me investigate the cause."),
  user("What's the root cause?"),
  assistant([{ type: "text", text: "The connection pool was exhausted." }]),
  liveMirror("The connection pool was exhausted."),
  strippedMirror("The connection pool was exhausted."),
  bareDuplicate("The connection pool was exhausted."),
];

console.log("\nBefore normalizeAssistantReplayContent (12 messages — 6 are mirrors):");
rebuildSessionContext.forEach((m, i) => {
  const rec = m as Record<string, unknown>;
  const role = typeof rec.role === "string" ? rec.role : "";
  const dm = rec.openclawDeliveryMirror;
  const prov = rec.provider;
  const isLive = prov === "openclaw" && rec.model === "delivery-mirror";
  const isStripped = dm !== undefined && !isLive;
  // bare duplicates are at indices 6 and 11 — positioned adjacent to real replies
  const isBare = i === 6 || i === 11;
  const mirrorType = isLive ? "LIVE-MIRROR" : isStripped ? "STRIPPED-MIRROR" : isBare ? "BARE-DUP" : "";
  console.log(`  [${i}] role=${role} ${mirrorType}`);
});

const case0Out = normalizeAssistantReplayContent(rebuildSessionContext);

console.log("\nAfter normalizeAssistantReplayContent → provider-bound prompt:");
case0Out.forEach((m, i) => {
  const rec = m as Record<string, unknown>;
  const role = typeof rec.role === "string" ? rec.role : "";
  const content = rec.content;
  const text = Array.isArray(content) && content[0] && typeof content[0] === "object"
    ? (content[0] as { text?: string }).text?.slice(0, 60) ?? ""
    : typeof content === "string"
      ? content.slice(0, 60)
      : "";
  console.log(`  [${i}] role=${role} text="${text}"`);
});

console.log("\nAssertions:");
check(case0Out.length === 6, `12→6 messages (6 delivery-mirror entries removed — live + stripped + bare)`);
check(case0Out.every((m) => {
  const rec = m as Record<string, unknown>;
  const dm = rec.openclawDeliveryMirror;
  const prov = rec.provider;
  return !((prov === "openclaw" && rec.model === "delivery-mirror") || dm !== undefined);
}), "No live-mirror or stripped-mirror entries in provider-bound output");
check(case0Out.some((m) => {
  const rec = m as Record<string, unknown>;
  const content = rec.content;
  return Array.isArray(content) && content.some((b: Record<string, unknown>) => b.type === "tool_use");
}), "Tool-use turn preserved (not collapsed by dedup)");

// ══════════════════════════════════════════════════════════════════════════
// Case 1 — Identity fallback (openclawDeliveryMirror field check)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log("Case 1 — openclawDeliveryMirror identity fallback");
console.log("═".repeat(64));

const stripped = strippedMirror("channel mirror text");
check(
  isTranscriptOnlyOpenClawAssistantMessage(stripped),
  "Stripped-metadata survivor → isTranscriptOnly=true (Layer 1 catches it)",
);

const normal = assistant([{ type: "text", text: "real reply" }]);
check(
  !isTranscriptOnlyOpenClawAssistantMessage(normal),
  "Normal assistant reply → isTranscriptOnly=false (correctly survives filter)",
);

// ══════════════════════════════════════════════════════════════════════════
// Case 2 — Adjacent bare duplicate collapse (Layer 2 only, no marker)
// ══════════════════════════════════════════════════════════════════════════
// Uses bareDuplicate: NO openclawDeliveryMirror marker. Layer 1 (identity
// fallback) CANNOT see this entry — it has no provider, model, or mirror
// marker. Only Layer 2 (byte-identical adjacent content dedup) can collapse it.
console.log("\n" + "═".repeat(64));
console.log("Case 2 — Adjacent bare duplicate collapse (Layer 2 only, no marker)");
console.log("═".repeat(64));

const case2Out = normalizeAssistantReplayContent([
  user("hi"),
  assistant([{ type: "text", text: "Hello! How can I help?" }]),
  bareDuplicate("Hello! How can I help?"), // no marker at all — only Layer 2 sees this
  user("thanks"),
]);

check(case2Out.length === 3, "4→3 messages (stripped-mirror duplicate collapsed)");
check(
  (case2Out[1] as Record<string, unknown>).role === "assistant",
  "Real assistant reply preserved at [1]",
);

// ══════════════════════════════════════════════════════════════════════════
// Case 3 — Both layers: identity fallback + adjacent dedup
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log("Case 3 — Both layers together in one pass");
console.log("═".repeat(64));

const case3Out = normalizeAssistantReplayContent([
  user("hi"),
  assistant([{ type: "text", text: "Hello! How can I help?" }]),
  strippedMirror("Different text — caught by identity fallback"),
  assistant([{ type: "text", text: "Hello! How can I help?" }]),
  strippedMirror("Hello! How can I help?"),
  user("thanks"),
]);

check(case3Out.length === 3, "6→3 messages (both layers active)");
check(
  case3Out.every((m) => !isTranscriptOnlyOpenClawAssistantMessage(m)),
  "No transcript-only messages in output",
);

// ══════════════════════════════════════════════════════════════════════════
// Case 4 — Native tool_use blocks prevent collapse (P1 fix)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log("Case 4 — Native tool_use blocks prevent collapse (P1 fix)");
console.log("═".repeat(64));

const case4Out = normalizeAssistantReplayContent([
  user("check the logs"),
  nativeToolUseTurn("Let me check that for you.", "toolu_001", "read"),
  assistant([{ type: "text", text: "Let me check that for you." }]),
]);

check(case4Out.length === 3, "3→3 messages (tool_use turn preserved, text-only turn also kept)");
const hasToolUse =
  Array.isArray((case4Out[1] as { content: unknown }).content) &&
  ((case4Out[1] as { content: Array<{ type: string }> }).content.some(
    (b) => b.type === "tool_use",
  ) ?? false);
check(hasToolUse, "Native tool_use block present at [1]");

// ══════════════════════════════════════════════════════════════════════════
// Case 5 — Native tool_use in BOTH prev and next
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log("Case 5 — Native tool_use in both prev and next prevents collapse");
console.log("═".repeat(64));

const case5Out = normalizeAssistantReplayContent([
  user("check logs and status"),
  nativeToolUseTurn("Checking...", "toolu_010", "read"),
  nativeToolUseTurn("Checking...", "toolu_011", "status"),
]);

check(case5Out.length === 3, "3→3 messages (both tool_use turns survive)");

// ══════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(64));
console.log("SUMMARY");
console.log("═".repeat(64));

if (failures === 0) {
  console.log("\n✓ ALL PROOF CASES PASSED — provider-bound prompt is clean");
  process.exit(0);
} else {
  console.log(`\n✗ ${failures} ASSERTION(S) FAILED`);
  process.exit(1);
}
