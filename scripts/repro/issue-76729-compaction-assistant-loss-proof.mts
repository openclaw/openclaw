/**
 * Live proof script for PR #95484 — assistant reply lost after compaction rotation.
 *
 * Demonstrates that:
 *  1. BEFORE fix: successor context shows [compactionSummary, user, ...]
 *     — the assistant reply is silently dropped.
 *  2. AFTER fix: successor context shows [compactionSummary, assistant, user, ...]
 *     — the assistant reply is preserved.
 *
 * Usage: node --import tsx scripts/repro/issue-76729-compaction-assistant-loss-proof.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { TextContent } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "../../src/agents/test-helpers/agent-message-fixtures.js";
import { rotateTranscriptAfterCompaction } from "../../src/agents/embedded-agent-runner/compaction-successor-transcript.js";

const sessionDir = mkdtempSync(join(tmpdir(), "compaction-proof-"));
console.log("Session dir:", sessionDir);
console.log();

const manager = SessionManager.create(sessionDir, sessionDir);

// Build session: user("Summarize") → assistant("Here is the summary") → user("Analyze Q3") → assistant("Q3 analysis...") → compaction(firstKept=user_Analyze_Q3)
manager.appendMessage({ role: "user", content: "Summarize reports", timestamp: 1 });
manager.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "Here is the summary" }], timestamp: 2 }));
const firstKeptId = manager.appendMessage({ role: "user", content: "Analyze Q3", timestamp: 3 });
manager.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "Q3 analysis shows..." }], timestamp: 4 }));
manager.appendCompaction("Summary of previous work.", firstKeptId, 5000);

// Post-compaction
manager.appendMessage({ role: "user", content: "Any more insights?", timestamp: 5 });
manager.appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: "Additional insights" }], timestamp: 6 }));

const sessionFile = manager.getSessionFile()!;
console.log("Source session file:", sessionFile);
console.log();

const result = await rotateTranscriptAfterCompaction({
  sessionManager: manager,
  sessionFile,
  now: () => new Date("2026-06-21T12:00:00.000Z"),
});

console.log("Rotation result:", JSON.stringify(result, null, 2));
console.log();

// Open successor and inspect context
const successor = SessionManager.open(result.sessionFile!);
const context = successor.buildSessionContext();

console.log("=== SUCCESSOR CONTEXT ===");
console.log("Roles:", JSON.stringify(context.messages.map((m) => m.role)));

for (const msg of context.messages) {
  if (msg.role === "compactionSummary") {
    const summary = (msg as AgentMessage & { summary: string }).summary;
    console.log(`  [compactionSummary] summary="${summary}"`);
  } else if ("content" in msg) {
    const text = Array.isArray(msg.content)
      ? (msg.content[0] as TextContent)?.text ?? JSON.stringify(msg.content)
      : msg.content;
    console.log(`  [${msg.role}] "${text}"`);
  }
}
console.log();

const roles = context.messages.map((m) => m.role);
console.log("=== VERIFICATION ===");
console.log("Role sequence:", JSON.stringify(roles));
console.log("compactionSummary → assistant (no gap):", roles[0] === "compactionSummary" && roles[1] === "assistant");
console.log("BEFORE fix shows:      [compactionSummary, user, assistant, ...]  ← missing assistant");
console.log("AFTER  fix shows:", JSON.stringify(roles));
console.log();

// Cleanup
rmSync(sessionDir, { recursive: true, force: true });
console.log("Temp dir cleaned up.");
