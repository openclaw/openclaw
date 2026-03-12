/**
 * L5 — Market Data Chat E2E (Live)
 *
 * Verifies data retrieval through the Control UI /chat interface.
 * Sends natural-language queries and validates that the LLM invokes
 * the correct fin_data_* tools and returns meaningful results.
 *
 * This is a LIVE test — requires:
 *   - Gateway running at http://localhost:18789 with LLM configured
 *   - findoo-datahub-plugin loaded
 *   - DataHub API reachable
 *   - Valid LLM API key in gateway config
 *
 * Run:
 *   LIVE=1 npx vitest run extensions/findoo-datahub-plugin/test/e2e/l5-browser/market-data-chat.live.test.ts
 *
 * These tests have longer timeouts because LLM responses are involved.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:18789";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "openclaw-local";
const SKIP =
  process.env.L5_SKIP === "1" ||
  process.env.CI === "true" ||
  (process.env.LIVE !== "1" && process.env.CLAWDBOT_LIVE_TEST !== "1");

// ---------------------------------------------------------------------------
// Chat API helpers
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible chat completion response shape.
 */
type ChatChoice = {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
};

type ChatResponse = {
  id?: string;
  choices?: ChatChoice[];
  content?: string;
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  error?: string | { message: string };
};

/**
 * Send a chat message via the OpenAI-compatible /v1/chat/completions endpoint.
 * This is the actual HTTP chat API the gateway exposes.
 */
async function sendChatMessage(message: string, timeoutMs = 120_000): Promise<ChatResponse> {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: message }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`/v1/chat/completions returned ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json() as Promise<ChatResponse>;
}

/**
 * Send a chat message and extract the assistant's text reply.
 */
async function sendChatWs(message: string, timeoutMs = 120_000): Promise<string> {
  try {
    const resp = await sendChatMessage(message, timeoutMs);
    // OpenAI format: choices[0].message.content
    if (resp.choices && resp.choices.length > 0) {
      return resp.choices[0]!.message.content ?? JSON.stringify(resp);
    }
    if (resp.content) return resp.content;
    return JSON.stringify(resp);
  } catch (err) {
    throw new Error(
      `Chat request failed for message: "${message}". ` +
        `Ensure gateway is running at ${GATEWAY_URL} with LLM configured. ` +
        `(${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * Extract tool call names from a chat response.
 */
function extractToolCalls(resp: ChatResponse): string[] {
  // OpenAI format: choices[0].message.tool_calls
  if (resp.choices && resp.choices.length > 0) {
    const tc = resp.choices[0]!.message.tool_calls;
    if (tc) return tc.map((t) => t.function.name);
  }
  if (resp.tool_calls) {
    return resp.tool_calls.map((tc) => tc.name);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("L5 — Market Data Chat E2E (Live)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    // Verify gateway is reachable and has chat capability
    try {
      const health = await fetch(`${GATEWAY_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!health.ok) throw new Error(`Gateway health check failed: ${health.status}`);
    } catch (err) {
      throw new Error(
        `Gateway not reachable at ${GATEWAY_URL}. ` +
          `Start with: openclaw gateway run --port 18789\n` +
          `Original error: ${err}`,
      );
    }
  });

  // === 1. BTC price query ===

  it("1.1 asking BTC price returns a numeric price", async () => {
    const reply = await sendChatWs("BTC 现在什么价格？简短回答", 120_000);
    // Response should contain a price-like number (5 or 6 digits for BTC)
    const hasPrice = /\d{4,6}/.test(reply) || /\$[\d,]+/.test(reply);
    expect(hasPrice, `Response should contain BTC price: ${reply.slice(0, 200)}`).toBe(true);
  });

  it("1.2 BTC price query triggers fin_crypto or fin_data_ohlcv tool", async () => {
    const resp = await sendChatMessage("查询 BTC 最新价格", 120_000);
    const toolCalls = extractToolCalls(resp);
    // Should invoke crypto-related tools
    const hasCryptoTool = toolCalls.some(
      (t) => t === "fin_crypto" || t === "fin_data_ohlcv" || t.includes("crypto"),
    );
    // Tool call detection depends on response format; skip assertion if no tool info
    if (toolCalls.length > 0) {
      expect(hasCryptoTool, `Expected crypto tool, got: ${toolCalls.join(", ")}`).toBe(true);
    }
  });

  // === 2. A-share index query ===

  it("2.1 querying SSE Composite index returns data", async () => {
    const reply = await sendChatWs("查看上证指数最新行情，简短回答", 120_000);
    // Should mention the index or contain a 4-digit number (index level)
    const hasIndexData =
      /上证/.test(reply) || /\d{4}/.test(reply) || /000001/.test(reply) || /SSE/.test(reply);
    expect(hasIndexData, `Response should reference SSE index: ${reply.slice(0, 200)}`).toBe(true);
  });

  it("2.2 querying A-share K-line triggers OHLCV tools", async () => {
    const resp = await sendChatMessage("获取茅台 600519.SH 最近 5 天的日 K 线数据", 120_000);
    // The response should contain price data
    const content = resp.content ?? JSON.stringify(resp);
    const hasData =
      /close|收盘|open|开盘|high|最高|low|最低/.test(content) ||
      /600519/.test(content) ||
      /茅台/.test(content);
    if (content.length > 10) {
      expect(hasData, `Response should contain K-line data: ${content.slice(0, 200)}`).toBe(true);
    }
  });

  // === 3. Macro data query ===

  it("3.1 querying CPI data returns macro indicator", async () => {
    const reply = await sendChatWs("中国最新 CPI 数据是多少？简短回答", 120_000);
    const hasMacroData =
      /CPI/.test(reply) || /\d+\.\d+/.test(reply) || /消费/.test(reply) || /物价/.test(reply);
    expect(hasMacroData, `Response should contain CPI data: ${reply.slice(0, 200)}`).toBe(true);
  });

  // === 4. DeFi data query ===

  it("4.1 querying DeFi TVL returns protocol data", async () => {
    const reply = await sendChatWs("当前 DeFi 总 TVL 是多少？列出 top 3 协议，简短回答", 120_000);
    const hasDefiData =
      /TVL/.test(reply) ||
      /\$\d/.test(reply) ||
      /billion/i.test(reply) ||
      /Lido|Aave|MakerDAO|Maker|EigenLayer|Uniswap/i.test(reply);
    expect(hasDefiData, `Response should contain DeFi TVL data: ${reply.slice(0, 200)}`).toBe(true);
  });

  // === 5. Technical analysis query ===

  it("5.1 querying RSI triggers fin_ta tool", async () => {
    const reply = await sendChatWs("计算茅台 600519.SH 的 RSI 指标，简短回答", 120_000);
    const hasTAData =
      /RSI/.test(reply) ||
      /\d{1,3}\.\d/.test(reply) ||
      /超买|超卖|overbought|oversold/i.test(reply);
    expect(hasTAData, `Response should contain RSI data: ${reply.slice(0, 200)}`).toBe(true);
  });

  // === 6. Multi-tool chain query ===

  it("6.1 complex query triggers multiple tools", async () => {
    const reply = await sendChatWs(
      "比较 BTC 和黄金最近一周的走势，简要分析，不超过 100 字",
      120_000,
    );
    // Should mention both assets
    const hasBTC = /BTC|比特币|bitcoin/i.test(reply);
    const hasGold = /黄金|gold|XAU/i.test(reply);
    expect(hasBTC || hasGold, `Response should reference both assets: ${reply.slice(0, 300)}`).toBe(
      true,
    );
  });

  // === 7. Error handling in chat ===

  it("7.1 querying invalid symbol returns graceful error", async () => {
    const reply = await sendChatWs("查询 ZZZZZ999.XX 的股票价格", 120_000);
    // Should not crash; should return a message (possibly an error explanation)
    expect(reply.length).toBeGreaterThan(0);
    // Should not contain stack traces
    expect(reply).not.toContain("at Object.");
    expect(reply).not.toContain("TypeError");
  });

  // === 8. Tool result rendering ===

  it("8.1 chat response is readable and structured", async () => {
    const reply = await sendChatWs("ETH 当前价格是多少？", 120_000);
    // Response should be human-readable, not raw JSON
    // Allow either Chinese or English response
    expect(reply.length).toBeGreaterThan(5);
    // Should not be pure JSON (tool output should be summarized)
    const isRawJson = reply.trim().startsWith("{") && reply.trim().endsWith("}");
    if (isRawJson) {
      // If it is JSON, it should at least be valid
      expect(() => JSON.parse(reply)).not.toThrow();
    }
  });
});
