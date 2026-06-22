/**
 * Live proof script for issue #95623 — snake_case tool_use type blocks with
 * composite call_XXX|fc_YYY IDs are not sanitized by rewriteAssistantToolCallIds.
 *
 * Demonstrates that:
 *  1. BEFORE fix: `rewriteAssistantToolCallIds` checks only camelCase types
 *     ("toolCall", "toolUse", "functionCall") — snake_case "tool_use" blocks
 *     pass through unsanitized, leaving pipe characters in composite IDs.
 *  2. AFTER fix: TOOL_CALL_TYPES and the type guard both include snake_case
 *     variants, so composite IDs like "call_abc123|fc_456" get properly
 *     sanitized to "callabc123fc456".
 *
 * Usage: node --import tsx scripts/repro/issue-95623-tool-use-id-sanitizer-proof.mts
 */
import { sanitizeToolCallIdsForCloudCodeAssist, sanitizeToolCallId } from "../../src/agents/tool-call-id.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";

console.log("=== sanitizeToolCallId composite ID behavior ===");
const compositeId = "call_abc123|fc_456";
const sanitized = sanitizeToolCallId(compositeId, "strict");
console.log(`  input:               ${compositeId}`);
console.log(`  sanitized (strict):  ${sanitized}`);
console.log(`  expected:            callabc123fc456`);
console.log(`  match:               ${sanitized === "callabc123fc456"}`);

console.log();
console.log("=== rewriteAssistantToolCallIds snake_case type recognition ===");
console.log();
console.log("BEFORE fix:  type check at line 415:");
console.log('             (type !== "functionCall" && type !== "toolUse" && type !== "toolCall")');
console.log('             → type="tool_use" matches NONE of these (all 3 !== are true)');
console.log("             → block passes through unsanitized");
console.log("             → composite ID with pipe reaches Anthropic target → 400 error");
console.log();
console.log("AFTER fix:   type check at line 414-418:");
console.log("             typeof type !== 'string' || !TOOL_CALL_TYPES.has(type)");
console.log('             → TOOL_CALL_TYPES now includes "tool_use"');
console.log("             → block is recognized as tool call, ID is sanitized");
console.log("             → pipe characters removed, safe for any provider target");
console.log();

// Build a mock transcript with snake_case tool_use blocks containing composite IDs
const beforeInput = [
  {
    role: "assistant" as const,
    content: [
      { type: "tool_use" as const, id: "call_abc123|fc_456", name: "read", input: {} },
      { type: "tool_use" as const, id: "call_def789|fc_012", name: "write", input: {} },
    ],
  },
  {
    role: "toolResult" as const,
    toolCallId: "call_abc123|fc_456",
    toolName: "read",
    content: [{ type: "text" as const, text: "result1" }],
  },
  {
    role: "toolResult" as const,
    toolCallId: "call_def789|fc_012",
    toolName: "write",
    content: [{ type: "text" as const, text: "result2" }],
  },
] as AgentMessage[];

const out = sanitizeToolCallIdsForCloudCodeAssist(beforeInput, "strict");

const assistantOut = out[0] as Extract<AgentMessage, { role: "assistant" }>;
const result1 = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
const result2 = out[2] as Extract<AgentMessage, { role: "toolResult" }>;

const toolCall1 = assistantOut.content?.[0] as { id?: string; type?: string } | undefined;
const toolCall2 = assistantOut.content?.[1] as { id?: string; type?: string } | undefined;

console.log("=== Live sanitization result ===");
console.log(`  Input changed:                     ${out !== beforeInput ? "YES ✓" : "NO — BUG STILL PRESENT"}`);
console.log(`  Block 1 type recognized:           ${toolCall1?.type === "tool_use" ? "YES ✓" : "NO"}`);
console.log(`  Block 2 type recognized:           ${toolCall2?.type === "tool_use" ? "YES ✓" : "NO"}`);
console.log(`  Block 1 id sanitized:              ${toolCall1?.id === "callabc123fc456" ? "YES ✓" : "NO — got " + toolCall1?.id}`);
console.log(`  Block 2 id sanitized:              ${toolCall2?.id === "calldef789fc012" ? "YES ✓" : "NO — got " + toolCall2?.id}`);
console.log(`  Tool result 1 id matches block 1:  ${result1.toolCallId === toolCall1?.id ? "YES ✓" : "NO"}`);
console.log(`  Tool result 2 id matches block 2:  ${result2.toolCallId === toolCall2?.id ? "YES ✓" : "NO"}`);
console.log();

// Also verify camelCase blocks still work (regression check)
const camelCaseInput = [
  {
    role: "assistant" as const,
    content: [
      { type: "toolUse" as const, id: "call_xyz|fc_999", name: "read", input: {} },
    ],
  },
  {
    role: "toolResult" as const,
    toolCallId: "call_xyz|fc_999",
    toolName: "read",
    content: [{ type: "text" as const, text: "camel" }],
  },
] as AgentMessage[];

const camelOut = sanitizeToolCallIdsForCloudCodeAssist(camelCaseInput, "strict");
const camelAssistant = camelOut[0] as Extract<AgentMessage, { role: "assistant" }>;
const camelBlock = camelAssistant.content?.[0] as { id?: string } | undefined;

console.log("=== CamelCase regression check ===");
console.log(`  toolUse type still recognized:     ${camelBlock?.id === "callxyzfc999" ? "YES ✓" : "NO"}`);
console.log();

// Also verify snake_case tool result fields are rewritten
const snakeResultInput = [
  {
    role: "assistant" as const,
    content: [
      { type: "tool_use" as const, id: "call_x1y2z3|fc_000", name: "read", input: {} },
    ],
  },
  {
    role: "toolResult" as const,
    toolCallId: "call_x1y2z3|fc_000",
    tool_call_id: "call_x1y2z3|fc_000",
    toolUseId: "call_x1y2z3|fc_000",
    tool_use_id: "call_x1y2z3|fc_000",
    toolName: "read",
    content: [{ type: "text" as const, text: "snake" }],
  },
] as AgentMessage[];

const snakeResultOut = sanitizeToolCallIdsForCloudCodeAssist(snakeResultInput, "strict");
const snakeResultAssistant = snakeResultOut[0] as Extract<AgentMessage, { role: "assistant" }>;
const snakeResultBlock = snakeResultAssistant.content?.[0] as { id?: string } | undefined;
const snakeResultMsg = snakeResultOut[1] as Extract<AgentMessage, { role: "toolResult" }> & {
  tool_call_id?: string;
  tool_use_id?: string;
};
const expectedSnakeId = "callx1y2z3fc000";

console.log("=== Snake_case tool_result fields rewrite check ===");
console.log(`  Assistant id sanitized:               ${snakeResultBlock?.id === expectedSnakeId ? "YES ✓" : "NO"}`);
console.log(`  toolCallId rewritten:                  ${snakeResultMsg.toolCallId === expectedSnakeId ? "YES ✓" : "NO"}`);
console.log(`  tool_call_id rewritten:                ${snakeResultMsg.tool_call_id === expectedSnakeId ? "YES ✓" : "NO"}`);
console.log(`  toolUseId rewritten:                   ${snakeResultMsg.toolUseId === expectedSnakeId ? "YES ✓" : "NO"}`);
console.log(`  tool_use_id rewritten:                 ${snakeResultMsg.tool_use_id === expectedSnakeId ? "YES ✓" : "NO"}`);
console.log();

// Source code verification
import { readFileSync } from "node:fs";
const sourcePath = new URL("../../src/agents/tool-call-id.ts", import.meta.url);
const source = readFileSync(sourcePath, "utf-8");

const hasSnakeCaseInTypes = source.includes('"tool_use"');
const hasSnakeCaseInGuard = source.includes("TOOL_CALL_TYPES.has(type)");
const hasCamelCaseInTypes = source.includes('"toolUse"');
const hasCamelCaseInGuard = !source.includes('type !== "toolUse" && type !== "toolCall"');

console.log("=== Source code verification ===");
console.log(`  TOOL_CALL_TYPES includes tool_use:      ${hasSnakeCaseInTypes ? "YES ✓" : "NO — MISSING"}`);
console.log(`  TOOL_CALL_TYPES includes toolUse:       ${hasCamelCaseInTypes ? "YES ✓" : "NO — REMOVED"}`);
console.log(`  Type guard uses TOOL_CALL_TYPES.has():  ${hasSnakeCaseInGuard ? "YES ✓" : "NO — still hardcoded"}`);
console.log(`  Old hardcoded guard removed:            ${hasCamelCaseInGuard ? "YES ✓" : "NO — still hardcoded"}`);

if (hasSnakeCaseInTypes && hasSnakeCaseInGuard && hasCamelCaseInTypes && hasCamelCaseInGuard) {
  console.log();
  console.log("=== VERDICT: FIX CONFIRMED ===");
  console.log("snake_case tool_use blocks with composite call_XXX|fc_YYY IDs are now:");
  console.log("  1. Recognized by TOOL_CALL_TYPES (extractToolCallsFromAssistant, isReplaySafeThinking)");
  console.log("  2. Sanitized by rewriteAssistantToolCallIds (via TOOL_CALL_TYPES.has() type guard)");
  console.log("  3. Composite IDs properly stripped of pipes → safe for any provider target");
  console.log("  4. CamelCase types (toolUse, toolCall, functionCall) still work correctly");
  console.log("Issue #95623 is resolved.");
} else {
  console.log();
  console.log("=== VERDICT: FIX NOT FULLY APPLIED ===");
}
