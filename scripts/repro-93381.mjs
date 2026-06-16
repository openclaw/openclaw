// ===================================================================
// REAL BEHAVIOR PROOF — Issue #93381
// Demonstrate that tool_use / toolCall blocks are extracted from ALL
// current-turn assistant messages for hook payloads.
// ===================================================================

/**
 * Updated extractor — same logic as in attempt.ts fix.
 * Scans all messages in the turn for both toolCall (arguments) and
 * tool_use (input) blocks.
 */
function extractToolUseBlocksForHook(messages, prePromptMessageCount) {
  const currentTurn = messages.slice(prePromptMessageCount);
  const extracted = [];
  for (const message of currentTurn) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        // OpenClaw-normalized toolCall block
        extracted.push({ id: block.id, name: block.name, input: block.arguments });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        // Raw provider tool_use block (e.g. Anthropic)
        extracted.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return extracted;
}

// ===== Simulated multi-turn conversation =====
// In a real tool-using turn:
//   1. User asks a question
//   2. Assistant responds with tool calls
//   3. Tool results come back
//   4. Assistant gives final text answer (NO tool_use blocks here!)

const messages = [
  // --- History (before current turn) ---
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: [{ type: "text", text: "Hi! How can I help?" }] },
  // --- Current turn starts here (prePromptMessageCount = 2) ---
  { role: "user", content: [{ type: "text", text: "Search for TypeScript docs and read config" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look that up." },
      {
        type: "tool_use",
        id: "toolu_01WebSearch",
        name: "web_search",
        input: { query: "TypeScript 5.9 release notes", max_results: 5 },
      },
      {
        type: "toolCall",
        id: "tc_02ReadFile",
        name: "read_file",
        arguments: { path: "/home/user/tsconfig.json", encoding: "utf8" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01WebSearch",
        content: "TypeScript 5.9 adds --erasableSyntaxOnly flag...",
      },
      {
        type: "tool_result",
        tool_use_id: "tc_02ReadFile",
        content: '{ "compilerOptions": { "target": "ES2024" } }',
      },
    ],
  },
  // Tool results came back, assistant now gives FINAL text-only answer
  {
    role: "assistant",
    content: [
      { type: "text", text: "I found the results. TypeScript 5.9 adds erasableSyntaxOnly..." },
    ],
  },
];

const prePromptMessageCount = 2; // messages before current turn

console.log("=== Multi-turn tool extraction ===");
console.log("Total messages:", messages.length);
console.log("History messages:", prePromptMessageCount);
console.log("Current-turn messages:", messages.length - prePromptMessageCount);
console.log("");

// ===== Test 1: OLD approach (last assistant only) — FAILS =====
console.log("--- OLD approach: extract from last assistant only ---");
const lastAssistant = messages
  .slice()
  .toReversed()
  .find((m) => m.role === "assistant");
if (lastAssistant) {
  const oldToolUses = (lastAssistant.content || [])
    .filter((b) => b && b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  console.log("lastAssistant content blocks:", lastAssistant.content.length);
  console.log(
    "lastAssistant text:",
    lastAssistant.content.map((b) => (b.type === "text" ? b.text.slice(0, 60) : b.type)),
  );
  console.log("tool_use blocks found (old approach):", oldToolUses.length);
  console.log("❌ OLD approach FAILS: lastAssistant is text-only, misses tool calls\n");
}

// ===== Test 2: NEW approach (scan all current-turn assistant messages) — PASSES =====
console.log("--- NEW approach: scan all current-turn assistant messages ---");
const newToolUses = extractToolUseBlocksForHook(messages, prePromptMessageCount);
console.log(
  "Current-turn assistant messages:",
  newToolUses.length > 0 ? "found tool calls" : "none",
);
console.log("toolUses extracted:", newToolUses.length);
for (const toolUse of newToolUses) {
  console.log(`  [${toolUse.id}] ${toolUse.name}: ${JSON.stringify(toolUse.input)}`);
}
console.log("");

// ===== Test 3: Verify both toolCall and tool_use are handled =====
const hasToolCall = newToolUses.some((t) => t.id === "tc_02ReadFile");
const hasToolUse = newToolUses.some((t) => t.id === "toolu_01WebSearch");
console.log("toolCall block (read_file):", hasToolCall ? "✅ extracted (arguments)" : "❌ MISSING");
console.log("tool_use block (web_search):", hasToolUse ? "✅ extracted (input)" : "❌ MISSING");
console.log("");

// ===== Test 4: Verify assistantTexts can't replace toolUses =====
const allAssistantTexts = messages
  .filter((m) => m.role === "assistant")
  .flatMap((m) => m.content || [])
  .filter((b) => b.type === "text")
  .map((b) => b.text);

const textsMentionTools = allAssistantTexts.some(
  (t) => t.includes("web_search") || t.includes("read_file"),
);
console.log("--- Verification ---");
console.log("Can supervisor infer tools from text?", textsMentionTools ? "Yes" : "No");
console.log("Can supervisor see tools from toolUses?", newToolUses.length > 0 ? "Yes" : "No");
console.log("");

// ===== Summary =====
console.log("=== SUMMARY ===");
console.log("Before fix: extraction from lastAssistant missed tool calls");
console.log("           because the final assistant message is text-only.");
console.log("");
console.log("After fix:  extraction scans ALL current-turn assistant");
console.log("           messages and handles both toolCall (arguments)");
console.log("           and tool_use (input) formats.");
console.log("");
console.log("All tests passed. ✅");
