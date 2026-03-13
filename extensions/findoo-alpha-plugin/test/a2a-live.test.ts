/**
 * L2 — Findoo A2A Live Integration Test
 *
 * Tests real A2A communication with the remote strategy-agent (43.128.100.43:5085).
 * Requires network access to PRD server.
 *
 * Run: LIVE=1 npx vitest run extensions/findoo-alpha-plugin/test/a2a-live.test.ts
 */
import { describe, expect, it } from "vitest";
import { A2AClient } from "../src/a2a-client.js";

const SKIP = !process.env.LIVE;
const STRATEGY_AGENT_URL = process.env.STRATEGY_AGENT_URL ?? "http://43.128.100.43:5085";
const ASSISTANT_ID = process.env.STRATEGY_ASSISTANT_ID ?? "d2310a07-b552-453c-a8bb-7b9b86de6b23";

describe.skipIf(SKIP)("L2 — Findoo A2A Live", { timeout: 180_000 }, () => {
  const client = new A2AClient(STRATEGY_AGENT_URL, ASSISTANT_ID);

  it("1. strategy-agent /ok endpoint is reachable", async () => {
    const resp = await fetch(`${STRATEGY_AGENT_URL}/ok`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body).toHaveProperty("ok", true);
  });

  it("2. /assistants/search returns assistants", async () => {
    const resp = await fetch(`${STRATEGY_AGENT_URL}/assistants/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    expect(resp.ok).toBe(true);
    const assistants = await resp.json();
    expect(Array.isArray(assistants)).toBe(true);
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants[0]).toHaveProperty("assistant_id");
    expect(assistants[0]).toHaveProperty("graph_id", "strategy");
  });

  it("3. A2A message/send returns valid JSON-RPC response", async () => {
    const resp = await client.sendMessage("你好，请简要介绍你的能力", {
      timeoutMs: 120_000,
    });

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBeDefined();
    expect(resp.result !== undefined || resp.error !== undefined).toBe(true);

    if (resp.result) {
      console.log("[A2A] Result keys:", Object.keys(resp.result));
    }
    if (resp.error) {
      console.log("[A2A] Error:", resp.error);
    }
  });

  it("4. A2A message/send with data part (structured context)", async () => {
    const resp = await client.sendMessage("查看这只股票的基本情况", {
      data: { symbol: "600519.SS", market: "cn" },
      timeoutMs: 120_000,
    });

    expect(resp.jsonrpc).toBe("2.0");
    if (resp.result) {
      console.log("[A2A with data] Result preview:", JSON.stringify(resp.result).slice(0, 300));
    }
    if (resp.error) {
      console.log("[A2A with data] Error:", resp.error);
    }
  });

  it("5. A2A message/send with metadata (webhook injection)", async () => {
    const resp = await client.sendMessage("你好", {
      metadata: {
        webhook_url: "http://test-gateway:18789/hooks/wake",
        webhook_token: "test-token",
        query_summary: "你好",
      },
      timeoutMs: 120_000,
    });

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.result !== undefined || resp.error !== undefined).toBe(true);
    console.log(
      "[A2A with metadata] Response:",
      JSON.stringify(resp.result ?? resp.error).slice(0, 300),
    );
  });

  it("6. collectStreamResult returns A2AResponse from stream", async () => {
    const resp = await client.collectStreamResult("BTC当前价格趋势简要分析", {
      timeoutMs: 120_000,
    });

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.result !== undefined || resp.error !== undefined).toBe(true);

    if (resp.result) {
      console.log("[collectStream] Result preview:", JSON.stringify(resp.result).slice(0, 300));
    }
    if (resp.error) {
      console.log("[collectStream] Error:", resp.error);
    }
  });

  it("7. A2A supports threaded conversation", async () => {
    const resp1 = await client.sendMessage("记住这个：我关注茅台", {
      timeoutMs: 120_000,
    });
    expect(resp1.jsonrpc).toBe("2.0");

    const result1 = resp1.result as Record<string, unknown> | undefined;
    const threadId = (result1?.thread_id ?? result1?.threadId ?? result1?.taskId) as
      | string
      | undefined;

    if (threadId) {
      const resp2 = await client.sendMessage("我刚才说关注什么？", {
        threadId,
        timeoutMs: 120_000,
      });
      expect(resp2.jsonrpc).toBe("2.0");
      console.log(
        "[Thread] Follow-up result:",
        JSON.stringify(resp2.result ?? resp2.error).slice(0, 300),
      );
    } else {
      console.log("[Thread] No threadId in first response, skipping follow-up");
    }
  });
});
