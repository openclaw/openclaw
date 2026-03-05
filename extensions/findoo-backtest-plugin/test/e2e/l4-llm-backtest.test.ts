/**
 * L4 Full-chain LLM — Backtest tools via LLM chat completions.
 *
 * Tests that an LLM can understand a backtest request and call the correct
 * fin_backtest_* tool through the gateway's OpenAI-compatible endpoint.
 *
 * Requires a running gateway with:
 *   - findoo-backtest-plugin loaded
 *   - LLM model configured (e.g. litellm/moonshotai/kimi-k2.5)
 *   - http.endpoints.chatCompletions.enabled: true
 *
 * Usage:
 *   # Start gateway first:
 *   pnpm gateway:dev
 *
 *   # Then run:
 *   L4_LLM=1 pnpm test extensions/findoo-backtest-plugin/test/e2e/l4-llm-backtest.test.ts
 */

import { describe, expect, it } from "vitest";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:19001";
const AUTH_TOKEN = process.env.GATEWAY_TOKEN ?? "openclaw-local";
const MODEL = process.env.LLM_MODEL ?? "litellm/moonshotai/kimi-k2.5";
const TIMEOUT = 120_000; // LLM calls can be slow

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface ChatChoice {
  message: ChatMessage;
  finish_reason: string;
}

interface ChatResponse {
  choices: ChatChoice[];
  error?: { message: string };
}

async function chatCompletion(messages: ChatMessage[]): Promise<ChatResponse> {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat completions ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

describe.skipIf(!process.env.L4_LLM)("L4 LLM Full-chain — Backtest Tools", () => {
  // ------------------------------------------------------------------
  // 1. LLM calls fin_backtest_remote_list
  // ------------------------------------------------------------------
  it(
    "LLM invokes fin_backtest_remote_list when asked to list backtest tasks",
    async () => {
      const resp = await chatCompletion([
        {
          role: "user",
          content:
            "List all remote backtest tasks (use the fin_backtest_remote_list tool with limit=3).",
        },
      ]);

      expect(resp.error).toBeUndefined();
      expect(resp.choices.length).toBeGreaterThan(0);

      const msg = resp.choices[0].message;
      const finish = resp.choices[0].finish_reason;

      // The LLM should either:
      // a) Call the tool (finish_reason: "tool_calls") and return tool_calls
      // b) Return the result directly if gateway auto-executes tools
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // LLM decided to call the tool
        const toolCall = msg.tool_calls[0];
        expect(toolCall.function.name).toBe("fin_backtest_remote_list");
        console.log(
          "[L4] LLM requested tool:",
          toolCall.function.name,
          "args:",
          toolCall.function.arguments,
        );
      } else if (msg.content) {
        // Gateway auto-executed the tool and LLM responded with results
        // Content should mention backtest tasks or similar
        const lower = msg.content.toLowerCase();
        expect(
          lower.includes("task") ||
            lower.includes("backtest") ||
            lower.includes("回测") ||
            lower.includes("total") ||
            lower.includes("completed") ||
            lower.includes("bt-"),
        ).toBe(true);
        console.log("[L4] LLM returned content:", msg.content.slice(0, 300));
      } else {
        // Unexpected — fail with details
        throw new Error(`Unexpected response: finish=${finish}, no tool_calls or content`);
      }
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 2. LLM calls fin_backtest_remote_status
  // ------------------------------------------------------------------
  it(
    "LLM invokes fin_backtest_remote_status when asked about a task",
    async () => {
      const resp = await chatCompletion([
        {
          role: "user",
          content:
            "Check the status of backtest task bt-e50897d2cbda (use the fin_backtest_remote_status tool).",
        },
      ]);

      expect(resp.error).toBeUndefined();
      expect(resp.choices.length).toBeGreaterThan(0);

      const msg = resp.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCall = msg.tool_calls[0];
        expect(toolCall.function.name).toBe("fin_backtest_remote_status");
        const args = JSON.parse(toolCall.function.arguments);
        expect(args.task_id).toContain("bt-e50897d2cbda");
        console.log("[L4] LLM requested tool:", toolCall.function.name, "args:", args);
      } else if (msg.content) {
        const lower = msg.content.toLowerCase();
        expect(
          lower.includes("status") ||
            lower.includes("bt-e50897d2cbda") ||
            lower.includes("completed") ||
            lower.includes("failed") ||
            lower.includes("回测"),
        ).toBe(true);
        console.log("[L4] LLM returned content:", msg.content.slice(0, 300));
      }
    },
    TIMEOUT,
  );

  // ------------------------------------------------------------------
  // 3. LLM calls fin_backtest_strategy_check
  // ------------------------------------------------------------------
  it(
    "LLM invokes fin_backtest_strategy_check for strategy validation",
    async () => {
      const resp = await chatCompletion([
        {
          role: "user",
          content:
            "Validate the strategy at /tmp/nonexistent-strategy using fin_backtest_strategy_check tool.",
        },
      ]);

      expect(resp.error).toBeUndefined();
      expect(resp.choices.length).toBeGreaterThan(0);

      const msg = resp.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCall = msg.tool_calls[0];
        expect(toolCall.function.name).toBe("fin_backtest_strategy_check");
        console.log("[L4] LLM requested tool:", toolCall.function.name);
      } else if (msg.content) {
        // LLM might execute and return error about nonexistent path
        expect(
          msg.content.includes("error") ||
            msg.content.includes("not found") ||
            msg.content.includes("不存在") ||
            msg.content.includes("valid"),
        ).toBe(true);
        console.log("[L4] LLM returned content:", msg.content.slice(0, 300));
      }
    },
    TIMEOUT,
  );
});
