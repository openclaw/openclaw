// Real behavior proof for #76729: assistant message lost after compaction rotation.
// Usage: node --import tsx src/agents/embedded-agent-runner/compaction-successor-transcript.proof.mts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { rotateTranscriptAfterCompaction } from "./compaction-successor-transcript.js";

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp });
}

const dir = mkdtempSync(join(tmpdir(), "compaction-proof-"));
console.log("Session dir:", dir);
console.log();

const manager = SessionManager.create(dir, dir);

// Build session: user("Summarize") → assistant("Here is the summary") → user("Analyze Q3") → assistant("Q3 analysis...") → compaction(firstKept=user_Analyze_Q3)
manager.appendMessage({ role: "user", content: "Summarize reports", timestamp: 1 });
manager.appendMessage(makeAssistant("Here is the summary", 2));
const firstKeptId = manager.appendMessage({ role: "user", content: "Analyze Q3", timestamp: 3 });
manager.appendMessage(makeAssistant("Q3 analysis shows...", 4));
manager.appendCompaction("Summary of previous work.", firstKeptId, 5000);

// Post-compaction
manager.appendMessage({ role: "user", content: "Any more insights?", timestamp: 5 });
manager.appendMessage(makeAssistant("Additional insights", 6));

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

// === Open successor and inspect context ===
const successor = SessionManager.open(result.sessionFile!);
const context = successor.buildSessionContext();

console.log("=== SUCCESSOR CONTEXT ===");
console.log("Roles:", JSON.stringify(context.messages.map((m) => m.role)));

for (const msg of context.messages) {
  if (msg.role === "compactionSummary") {
    console.log(`  [compactionSummary] summary="${(msg as any).summary}"`);
  } else if ("content" in msg) {
    const text = Array.isArray(msg.content)
      ? (msg.content[0] as any)?.text ?? JSON.stringify(msg.content)
      : msg.content;
    console.log(`  [${msg.role}] "${text}"`);
  }
}
console.log();

// === Verification ===
const roles = context.messages.map((m) => m.role);
const hasOldAssistant = roles[1] === "assistant";
const noGap = roles.includes("compactionSummary") && roles.includes("assistant") && roles.indexOf("assistant") < roles.lastIndexOf("user");
console.log("=== VERIFICATION ===");
console.log("Role sequence:", JSON.stringify(roles));
console.log("compactionSummary → assistant (no gap):", roles[0] === "compactionSummary" && roles[1] === "assistant");
console.log("BEFORE fix would show: [compactionSummary, user, assistant, ...] — missing assistant");
console.log("AFTER  fix shows:     ", JSON.stringify(roles));
console.log();

// Cleanup
rmSync(dir, { recursive: true, force: true });
console.log("Temp dir cleaned up.");
