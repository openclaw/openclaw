/**
 * Real behavior proof: legacy Anthropic thinking budget < 1024 is resolved as
 * disabled at both option-resolution and raw-builder layers.
 *
 * Usage: node --import tsx proof-anthropic-thinking-budget.mts
 *
 * Negative control: temporarily replace the provider source with origin/main
 * and re-run to see the pre-fix || override and missing guards.
 */
import { streamAnthropic, streamSimpleAnthropic } from "./packages/ai/src/providers/anthropic.js";

type TestCase = {
  label: string;
  /** "simple" goes through streamSimpleAnthropic (option resolution),
   *  "raw" calls streamAnthropic directly (builder-only path). */
  path: "simple" | "raw";
  modelMaxTokens: number;
  reasoning: string | undefined;
  thinkingBudgetTokens?: number;
  thinkingEnabled?: boolean;
  expectThinking: "disabled" | "enabled" | "omitted";
};

const BASE_MODEL = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  provider: "anthropic" as const,
  api: "anthropic-messages" as const,
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
};

const BASE_CTX = {
  messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
};

const cases: TestCase[] = [
  // --- streamSimpleAnthropic (option resolution path) ---
  {
    label: "simple: budget collapses to 0 (1024-token model, minimal reasoning)",
    path: "simple",
    modelMaxTokens: 1024,
    reasoning: "minimal",
    expectThinking: "disabled",
  },
  {
    label: "simple: budget is sub-minimum (1500-token model, low reasoning → 476)",
    path: "simple",
    modelMaxTokens: 1500,
    reasoning: "low",
    expectThinking: "disabled",
  },
  {
    label: "simple: valid budget (8192-token model, medium reasoning)",
    path: "simple",
    modelMaxTokens: 8192,
    reasoning: "medium",
    expectThinking: "enabled",
  },
  // --- raw streamAnthropic (builder-only path, no option resolution) ---
  {
    label: "raw: explicit zero budget with thinkingEnabled:true",
    path: "raw",
    modelMaxTokens: 8192,
    reasoning: undefined,
    thinkingEnabled: true,
    thinkingBudgetTokens: 0,
    expectThinking: "omitted",
  },
  {
    label: "raw: sub-minimum budget (512) with thinkingEnabled:true",
    path: "raw",
    modelMaxTokens: 8192,
    reasoning: undefined,
    thinkingEnabled: true,
    thinkingBudgetTokens: 512,
    expectThinking: "omitted",
  },
  {
    label: "raw: valid budget (2048) with thinkingEnabled:true",
    path: "raw",
    modelMaxTokens: 8192,
    reasoning: undefined,
    thinkingEnabled: true,
    thinkingBudgetTokens: 2048,
    expectThinking: "enabled",
  },
  {
    label: "raw: thinkingEnabled:false with zero budget",
    path: "raw",
    modelMaxTokens: 8192,
    reasoning: undefined,
    thinkingEnabled: false,
    thinkingBudgetTokens: 0,
    expectThinking: "disabled",
  },
];

let passed = 0;
let failed = 0;

for (const tc of cases) {
  console.log("[case] %s", tc.label);
  const model = { ...BASE_MODEL, maxTokens: tc.modelMaxTokens };
  let captured: Record<string, unknown> | undefined;

  try {
    if (tc.path === "simple") {
      const stream = streamSimpleAnthropic(model, BASE_CTX, {
        apiKey: "sk-ant-proof",
        reasoning: tc.reasoning as Parameters<typeof streamSimpleAnthropic>[2]["reasoning"],
        onPayload: (p) => {
          captured = p as Record<string, unknown>;
          throw new Error("stop before network");
        },
      });
      await stream.result();
    } else {
      const stream = streamAnthropic(model, BASE_CTX, {
        apiKey: "sk-ant-proof",
        thinkingEnabled: tc.thinkingEnabled,
        thinkingBudgetTokens: tc.thinkingBudgetTokens,
        onPayload: (p) => {
          captured = p as Record<string, unknown>;
          throw new Error("stop before network");
        },
      });
      await stream.result();
    }
  } catch {
    // expected — onPayload throws to stop before network
  }

  const thinking = captured?.thinking;
  const actual =
    thinking === undefined
      ? "omitted"
      : (thinking as Record<string, unknown>).type === "disabled"
        ? "disabled"
        : "enabled";

  const ok = actual === tc.expectThinking;
  console.log("  thinking: %s", JSON.stringify(thinking));
  console.log("  expected: %s, actual: %s → %s", tc.expectThinking, actual, ok ? "PASS" : "FAIL");
  if (!ok) {
    console.log("  DETAIL: %s", JSON.stringify(thinking));
  }

  if (ok) passed++;
  else failed++;

  console.log();
}

console.log("=== Proof Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);

if (failed > 0) {
  process.exitCode = 1;
}
