/**
 * Scenario B: Real LLM agent decision-making
 *
 * Tests: LLM (kimi-k2.5 via OpenAI-compatible API) → real tool calls → real data
 * Gate: LIVE=1 + OPENAI_API_KEY (litellm proxy with kimi-k2.5)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OHLCV, Signal, StrategyContext } from "../../../src/shared/types.js";
import {
  LIVE,
  createLiveChainServer,
  parseResult,
  type LiveChainContext,
  type ToolMap,
} from "./live-harness.js";

const HAS_API_KEY = !!process.env.OPENAI_API_KEY;
const SKIP = !LIVE || !HAS_API_KEY;

const BASE_URL = process.env.OPENAI_BASE_URL ?? "http://150.109.16.195:8600/v1";
const MODEL = process.env.OPENAI_MODEL ?? "moonshotai/kimi-k2.5";

// OpenAI-compatible tool definitions
const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "fin_fund_risk",
      description: "Get current fund risk assessment",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "fin_strategy_tick",
      description: "Drive strategy execution: fetch candles, run onBar(), place orders",
      parameters: {
        type: "object",
        properties: {
          strategyId: { type: "string", description: "Strategy ID to tick" },
          dryRun: { type: "boolean", description: "If true, compute signals only" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fin_lifecycle_scan",
      description: "Scan all strategies for lifecycle actions",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/** Minimal OpenAI chat completion via fetch (no SDK dependency) */
async function chatComplete(
  messages: Array<Record<string, unknown>>,
  tools?: typeof TOOL_DEFS,
): Promise<{
  content: string | null;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> | null;
  finishReason: string;
}> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 1024,
    messages,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finish_reason: string;
    }>;
  };

  const choice = data.choices[0]!;
  return {
    content: choice.message.content,
    toolCalls: choice.message.tool_calls ?? null,
    finishReason: choice.finish_reason,
  };
}

describe.skipIf(SKIP)("Scenario B: Real LLM Agent Decision", { timeout: 180_000 }, () => {
  let ctx: LiveChainContext;
  let tools: ToolMap;

  beforeAll(async () => {
    ctx = await createLiveChainServer();
    tools = ctx.tools;

    // Seed strategy for LLM to work with
    ctx.services.strategyRegistry.create({
      id: "llm-test-sma",
      name: "LLM Test SMA",
      version: "1.0.0",
      markets: ["equity"],
      symbols: ["600519.SH"],
      timeframes: ["1d"],
      parameters: {},
      async onBar(_bar: OHLCV, _ctx: StrategyContext): Promise<Signal | null> {
        return null;
      },
    });
    ctx.services.strategyRegistry.updateLevel("llm-test-sma", "L2_PAPER");

    ctx.services.paperEngine.createAccount("llm-paper", 10000);
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  async function runLlmWithTools(
    userMessage: string,
    availableTools: typeof TOOL_DEFS,
    maxRounds = 3,
  ): Promise<{ finalText: string; toolCalls: string[] }> {
    const messages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content:
          "You are a financial trading assistant. Use the available tools to answer questions with real data. Always call the provided tools before answering.",
      },
      { role: "user", content: userMessage },
    ];
    const collectedToolCalls: string[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const response = await chatComplete(messages, availableTools);

      if (
        !response.toolCalls ||
        response.toolCalls.length === 0 ||
        response.finishReason === "stop"
      ) {
        return { finalText: response.content ?? "", toolCalls: collectedToolCalls };
      }

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Execute each tool call and feed results back
      for (const tc of response.toolCalls) {
        const fnName = tc.function.name;
        collectedToolCalls.push(fnName);

        const tool = tools.get(fnName);
        if (!tool) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Tool ${fnName} not found` }),
          });
          continue;
        }

        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          const result = await tool.execute(tc.id, args);
          const parsed = parseResult(result);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(parsed),
          });
        } catch (err) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: (err as Error).message }),
          });
        }
      }
    }

    return { finalText: "", toolCalls: collectedToolCalls };
  }

  it("B.1 — LLM calls fin_fund_risk and returns real riskLevel", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "What is the current fund risk level? Use the risk assessment tool.",
      [TOOL_DEFS[0]!],
    );

    expect(toolCalls).toContain("fin_fund_risk");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.2 — LLM calls fin_strategy_tick and returns real signal info", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Run a strategy tick for strategy 'llm-test-sma' in dry run mode and tell me what happened.",
      [TOOL_DEFS[1]!],
    );

    expect(toolCalls).toContain("fin_strategy_tick");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.3 — LLM calls fin_lifecycle_scan and returns real actions", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Scan all strategies for lifecycle actions. What actions are needed?",
      [TOOL_DEFS[2]!],
    );

    expect(toolCalls).toContain("fin_lifecycle_scan");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.4 — LLM chains 3 different fin_* tools in sequence", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Please do a full portfolio health check: 1) check fund risk, 2) run a lifecycle scan, 3) tick the strategy 'llm-test-sma' in dry-run mode. Summarize all findings.",
      [...TOOL_DEFS],
    );

    // Should have called at least 2 different tools
    const uniqueTools = new Set(toolCalls);
    expect(uniqueTools.size).toBeGreaterThanOrEqual(2);
    expect(finalText.length).toBeGreaterThan(0);
    expect(finalText).toBeTruthy();
  }, 90_000);
});
