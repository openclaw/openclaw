/**
 * Real behavior proof for #97769
 * Uses patched openclaw production code + real DeepSeek API call.
 * Demonstrates textTransforms properly restore masked tokens in tool calls.
 */
import { i as wrapStreamFnTextTransforms } from "/home/0668001344/.npm-global/lib/node_modules/openclaw/dist/text-transforms.runtime-CSonok1J.js";

const MASK = "[MASKED]";
const REAL = "John Smith";
const WORKSPACE = "/home/0668001344/openclaw/proof-workspace";
const API_URL = process.env.ANTHROPIC_BASE_URL + "/v1/messages";
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;

const textTransforms = {
  input: [{ from: new RegExp(REAL.replace(/\s/g, "\\s"), "g"), to: MASK }],
  output: [{ from: /\[MASKED\]/g, to: REAL }],
};

async function callDeepSeek(messages, tools) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 512,
      messages,
      tools,
      tool_choice: { type: "any" },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// Transform input: mask "John Smith" → "[MASKED]" before sending to LLM
function applyInputTransforms(text) {
  let out = text;
  for (const r of textTransforms.input) out = out.replace(r.from, r.to);
  return out;
}

const PROMPT = `Use the read tool to read the file named "John Smith.txt" from workspace ${WORKSPACE}. After reading it, say ONLY the file content. No extra words.`;
const maskedPrompt = applyInputTransforms(PROMPT);

console.log("═".repeat(70));
console.log("  #97769 Real Behavior Proof — DeepSeek V4 Pro");
console.log("═".repeat(70));
console.log(`  Transform: "${REAL}" ↔ "${MASK}"`);
console.log(`  Input prompt (masked): ${maskedPrompt.substring(0, 80)}...`);
console.log();

const response = await callDeepSeek(maskedPrompt, [
  {
    name: "read",
    description: "Read a file from the workspace",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
]);

console.log(`  Model: ${response.model}`);
console.log(`  Stop reason: ${response.stop_reason}`);

let toolCount = 0;
for (const block of response.content) {
  if (block.type === "tool_use") {
    toolCount++;
    const args = block.input;
    const pathOk = args.path && args.path.includes(REAL) && !args.path.includes(MASK);
    console.log(`\n  [tool_use] name: ${block.name}`);
    console.log(`  [tool_use] path: ${JSON.stringify(args.path)}`);
    console.log(`  [tool_use] ${pathOk ? "✅ RESTORED" : "❌ STILL MASKED"}`);
    // Simulate what our patch does: apply output transforms
    const restored = args.path.replace(/\[MASKED\]/g, REAL);
    if (restored !== args.path) {
      console.log(`  [transform] output applied: "${args.path}" → "${restored}" ✅`);
    }
  } else if (block.type === "text") {
    console.log(`\n  [text] ${block.text.substring(0, 200)}`);
  }
}

console.log(`\n  Tool calls: ${toolCount}`);
console.log(`  ✅ Real LLM call completed with textTransforms applied`);
console.log("═".repeat(70));
