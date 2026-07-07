// Real behavior proof for PR 101283.
// Drives the actual streamAnthropic direct provider and stops before the
// network by throwing from onPayload, then prints the constructed Anthropic
// request payload. Proves that explicit zero and sub-minimum
// thinkingBudgetTokens no longer emit an enabled thinking block after the fix,
// while a valid budget still does.
import { streamAnthropic } from "./packages/ai/src/providers/anthropic.js";
import type { Model } from "./packages/ai/src/providers/types.js";

let failed = 0;
let passed = 0;

function ok(message: string): void {
  passed += 1;
  console.log(`  ok: ${message}`);
}

function notOk(message: string): void {
  failed += 1;
  console.log(`  FAIL: ${message}`);
}

function makeLegacyBudgetModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    api: "anthropic-messages",
    provider: "anthropic",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } as Model<"anthropic-messages">;
}

async function capturePayload(
  thinkingBudgetTokens: number,
): Promise<Record<string, unknown> | undefined> {
  let captured: Record<string, unknown> | undefined;
  const stream = streamAnthropic(
    makeLegacyBudgetModel(),
    {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    },
    {
      apiKey: "sk-test",
      thinkingEnabled: true,
      thinkingBudgetTokens,
      onPayload: (payload) => {
        captured = payload as Record<string, unknown>;
        throw new Error("stop before network");
      },
    },
  );
  await stream.result().catch(() => undefined);
  return captured;
}

async function caseZeroBudget(): Promise<void> {
  console.log("[case 1] explicit zero budget omits thinking block");
  const payload = await capturePayload(0);
  console.log(`  payload.thinking: ${JSON.stringify(payload?.thinking)}`);
  if (payload?.thinking === undefined) {
    ok("thinking block omitted");
  } else {
    notOk(`thinking block omitted (got ${JSON.stringify(payload.thinking)})`);
  }
}

async function caseSubMinimumBudget(): Promise<void> {
  console.log("[case 2] sub-minimum budget (512) omits thinking block");
  const payload = await capturePayload(512);
  console.log(`  payload.thinking: ${JSON.stringify(payload?.thinking)}`);
  if (payload?.thinking === undefined) {
    ok("thinking block omitted");
  } else {
    notOk(`thinking block omitted (got ${JSON.stringify(payload.thinking)})`);
  }
}

async function caseValidBudget(): Promise<void> {
  console.log("[case 3] valid budget (2048) emits enabled thinking block");
  const payload = await capturePayload(2048);
  console.log(`  payload.thinking: ${JSON.stringify(payload?.thinking)}`);
  const thinking = payload?.thinking as Record<string, unknown> | undefined;
  if (
    thinking?.type === "enabled" &&
    thinking.budget_tokens === 2048 &&
    thinking.display === "summarized"
  ) {
    ok("enabled thinking block emitted");
  } else {
    notOk(`enabled thinking block emitted (got ${JSON.stringify(thinking)})`);
  }
}

async function main(): Promise<void> {
  await caseZeroBudget();
  await caseSubMinimumBudget();
  await caseValidBudget();

  console.log("");
  console.log(`=== Proof Summary ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
