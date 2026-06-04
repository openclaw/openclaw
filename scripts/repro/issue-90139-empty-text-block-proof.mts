import { dropReasoningFromHistory, dropThinkingBlocks } from "../../src/agents/embedded-agent-runner/thinking.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";

const OMITTED = "[assistant reasoning omitted]";

function toAgentMessages(msgs: Array<{ role: string; content: unknown }>): AgentMessage[] {
  return msgs as unknown as AgentMessage[];
}

function makeMessages(): Record<string, AgentMessage[]> {
  return {
    thinkingOnly: toAgentMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "thinking", thinking: "old" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ]),
    thinkingAndEmptyText: toAgentMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "thinking", thinking: "old" }, { type: "text", text: "" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ]),
    thinkingAndWhitespaceText: toAgentMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "thinking", thinking: "old" }, { type: "text", text: "   " }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ]),
    thinkingAndRealText: toAgentMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "thinking", thinking: "old" }, { type: "text", text: "" }, { type: "text", text: "real answer" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ]),
  };
}

function textOf(msg: { content: unknown }) {
  const c = msg.content as Array<{ type: string; text?: string }>;
  return c.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(", ");
}

let failures = 0;

function check(name: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`  PASS: ${name}`);
  } else {
    console.log(`  FAIL: ${name}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    failures++;
  }
}

console.log("=== Reproduction for issue #90139 ===\n");

const cases = makeMessages();

// --- dropThinkingBlocks ---
console.log("-- dropThinkingBlocks --");
{
  const result = dropThinkingBlocks(cases.thinkingOnly);
  check("thinking-only -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropThinkingBlocks(cases.thinkingAndEmptyText);
  check("thinking + empty text -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropThinkingBlocks(cases.thinkingAndWhitespaceText);
  check("thinking + whitespace text -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropThinkingBlocks(cases.thinkingAndRealText);
  check("thinking + empty + real text -> real answer", textOf(result[1]), "real answer");
}

// --- dropReasoningFromHistory ---
console.log("\n-- dropReasoningFromHistory --");
{
  const result = dropReasoningFromHistory(cases.thinkingOnly);
  check("thinking-only -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropReasoningFromHistory(cases.thinkingAndEmptyText);
  check("thinking + empty text -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropReasoningFromHistory(cases.thinkingAndWhitespaceText);
  check("thinking + whitespace text -> omitted", textOf(result[1]), OMITTED);
}
{
  const result = dropReasoningFromHistory(cases.thinkingAndRealText);
  check("thinking + empty + real text -> real answer", textOf(result[1]), "real answer");
}

console.log("\n=========================");
if (failures === 0) {
  console.log("All checks passed.");
} else {
  console.log(`${failures} check(s) failed.`);
  process.exitCode = 1;
}
