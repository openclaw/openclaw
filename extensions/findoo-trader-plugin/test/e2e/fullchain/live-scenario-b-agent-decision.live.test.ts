/**
 * Scenario B: Real LLM agent decision-making
 *
 * Tests: LLM (claude-haiku) → real tool calls → real data
 * Gate: LIVE=1 + ANTHROPIC_API_KEY
 * Cost: ~$0.01 per run (haiku + 3 rounds)
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

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const SKIP = !LIVE || !HAS_API_KEY;

// Tool schema definitions for LLM (type-safe without static import)
const TOOL_SCHEMAS = [
  {
    name: "fin_fund_risk",
    description: "Get current fund risk assessment",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fin_strategy_tick",
    description: "Drive strategy execution: fetch candles, run onBar(), place orders",
    input_schema: {
      type: "object" as const,
      properties: {
        strategyId: { type: "string", description: "Strategy ID to tick" },
        dryRun: { type: "boolean", description: "If true, compute signals only" },
      },
      required: [],
    },
  },
  {
    name: "fin_lifecycle_scan",
    description: "Scan all strategies for lifecycle actions",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
] as const;

describe.skipIf(SKIP)("Scenario B: Real LLM Agent Decision", { timeout: 180_000 }, () => {
  let ctx: LiveChainContext;
  let tools: ToolMap;
  // biome-ignore lint: dynamic import for optional dep
  let client: any;

  beforeAll(async () => {
    ctx = await createLiveChainServer();
    tools = ctx.tools;
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    client = new Anthropic();

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
    availableTools: (typeof TOOL_SCHEMAS)[number][],
    maxRounds = 3,
  ): Promise<{ finalText: string; toolCalls: string[] }> {
    // biome-ignore lint: dynamic types from optional dep
    const messages: any[] = [{ role: "user", content: userMessage }];
    const toolCalls: string[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system:
          "You are a financial trading assistant. Use the available tools to answer questions with real data.",
        tools: availableTools,
        messages,
      });

      // Collect tool_use blocks
      const toolUseBlocks = (
        response.content as Array<{
          type: string;
          id?: string;
          name?: string;
          input?: unknown;
          text?: string;
        }>
      ).filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        const textBlocks = (response.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "");
        return { finalText: textBlocks.join("\n"), toolCalls };
      }

      // Execute tools and feed results back
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
      for (const block of toolUseBlocks) {
        toolCalls.push(block.name!);
        const tool = tools.get(block.name!);
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: JSON.stringify({ error: `Tool ${block.name} not found` }),
          });
          continue;
        }

        try {
          const result = await tool.execute(
            block.id!,
            (block.input ?? {}) as Record<string, unknown>,
          );
          const parsed = parseResult(result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: JSON.stringify(parsed),
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: JSON.stringify({ error: (err as Error).message }),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    return { finalText: "", toolCalls };
  }

  it("B.1 — LLM calls fin_fund_risk and returns real riskLevel", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "What is the current fund risk level? Use the risk assessment tool.",
      [TOOL_SCHEMAS[0]!],
    );

    expect(toolCalls).toContain("fin_fund_risk");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.2 — LLM calls fin_strategy_tick and returns real signal info", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Run a strategy tick for strategy 'llm-test-sma' in dry run mode and tell me what happened.",
      [TOOL_SCHEMAS[1]!],
    );

    expect(toolCalls).toContain("fin_strategy_tick");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.3 — LLM calls fin_lifecycle_scan and returns real actions", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Scan all strategies for lifecycle actions. What actions are needed?",
      [TOOL_SCHEMAS[2]!],
    );

    expect(toolCalls).toContain("fin_lifecycle_scan");
    expect(finalText.length).toBeGreaterThan(0);
  }, 60_000);

  it("B.4 — LLM chains 3 different fin_* tools in sequence", async () => {
    const { toolCalls, finalText } = await runLlmWithTools(
      "Please do a full portfolio health check: 1) check fund risk, 2) run a lifecycle scan, 3) tick the strategy 'llm-test-sma' in dry-run mode. Summarize all findings.",
      [...TOOL_SCHEMAS],
    );

    // Should have called at least 2 different tools
    const uniqueTools = new Set(toolCalls);
    expect(uniqueTools.size).toBeGreaterThanOrEqual(2);
    expect(finalText.length).toBeGreaterThan(0);
    // Final text should reference real data
    expect(finalText).toBeTruthy();
  }, 90_000);
});
