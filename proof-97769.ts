/**
 * Proof script for #97769
 * Demonstrates that textTransforms output replacements now apply to
 * toolcall_delta and toolcall_end events (previously bypassed).
 */
import {
  wrapStreamFnTextTransforms,
  applyPluginTextReplacements,
} from "./src/agents/plugin-text-transforms.js";
import type { StreamFn } from "./src/agents/runtime/index.js";
import { createAssistantMessageEventStream } from "./src/agents/stream-compat.js";

const MASKED = "[MASKED]";
const REAL = "John";
const OUTPUT = [{ from: /\[MASKED\]/g, to: REAL }];

// ── Stream simulating LLM output with masked tokens ──
const baseStreamFn: StreamFn = (_model, _context) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    // toolcall_delta — streaming tool call args with masked token
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify({ name: MASKED, id: "123" }),
      partial: { name: MASKED, id: "123" },
    } as never);
    // toolcall_end — terminal tool call with nested masked tokens
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "call-1",
        name: "search",
        arguments: { query: MASKED, nested: { note: `ask ${MASKED} again` }, entries: [MASKED, 7] },
      },
    } as never);
    // done.message — accumulated result with tool-call content block
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "done." },
          { type: "toolCall", name: "send_msg", arguments: { text: MASKED } },
        ],
      },
    } as never);
    stream.end();
  });
  return stream;
};

async function main() {
  const wrapped = wrapStreamFnTextTransforms({ streamFn: baseStreamFn, output: OUTPUT });
  const stream = await Promise.resolve(wrapped({} as never, {} as never, undefined));
  const events: any[] = [];
  for await (const event of stream) events.push(event);

  console.log("=".repeat(60));
  console.log("  #97769 Proof — textTransforms on toolcall_delta / toolcall_end");
  console.log("=".repeat(60));
  console.log(`  Replace: ${MASKED} → ${REAL}\n`);

  let deltaOk = false,
    endOk = false,
    resultOk = false;

  const delta = events.find((e) => e?.type === "toolcall_delta");
  if (delta) {
    deltaOk = !(delta.delta as string).includes(MASKED) && (delta.delta as string).includes(REAL);
    console.log(`  [toolcall_delta]`);
    console.log(`    delta: ${JSON.stringify(delta.delta)}`);
    console.log(
      `    ${deltaOk ? "✅ PASS" : "❌ FAIL"} — masked token ${deltaOk ? "restored" : "LEAKED"}\n`,
    );
  }

  const end = events.find((e) => e?.type === "toolcall_end");
  if (end) {
    const tc = end.toolCall;
    const args = tc?.arguments;
    endOk =
      tc.name === "search" &&
      JSON.stringify(args).includes(REAL) &&
      !JSON.stringify(args).includes(MASKED);
    console.log(`  [toolcall_end]`);
    console.log(
      `    name:       "${tc.name}" ${tc.name === "search" ? "✅ preserved" : "❌ CHANGED"}`,
    );
    console.log(`    arguments:  ${JSON.stringify(args)}`);
    console.log(
      `    ${endOk ? "✅ PASS" : "❌ FAIL"} — nested args ${endOk ? "restored" : "LEAKED"}\n`,
    );
  }

  const result = await stream.result();
  const toolBlock = (result.content as any[])?.find((b) => b?.type === "toolCall");
  if (toolBlock) {
    resultOk =
      !JSON.stringify(toolBlock.arguments).includes(MASKED) &&
      JSON.stringify(toolBlock.arguments).includes(REAL);
    console.log(`  [result.content toolCall block]`);
    console.log(`    arguments:  ${JSON.stringify(toolBlock.arguments)}`);
    console.log(
      `    ${resultOk ? "✅ PASS" : "❌ FAIL"} — result path ${resultOk ? "restored" : "LEAKED"}\n`,
    );
  }

  const allOk = deltaOk && endOk && resultOk;
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  VERDICT: ${allOk ? "✅ ALL PATHS PASS" : "❌ FAILURES DETECTED"}`);
  console.log("=".repeat(60));

  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
