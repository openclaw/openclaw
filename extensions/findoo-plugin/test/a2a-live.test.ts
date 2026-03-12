/**
 * L2 — Findoo A2A Live Integration Test
 *
 * Tests real A2A communication with the remote strategy-agent (43.128.100.43:5085).
 * Requires network access to PRD server.
 *
 * Run: LIVE=1 npx vitest run extensions/findoo-plugin/test/a2a-live.test.ts
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
    // Should have result (success) or error
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

  it("5. A2A message/stream returns SSE events and final result", async () => {
    const events: Array<{ kind: string; state?: string; final: boolean }> = [];

    for await (const event of client.sendMessageStream("你好，请简要介绍你的能力", {
      timeoutMs: 120_000,
    })) {
      events.push({
        kind: event.kind,
        state: event.status?.state,
        final: event.final,
      });
      console.log("[SSE]", event.kind, event.status?.state, event.final ? "(final)" : "");
    }

    // Should have at least one event
    expect(events.length).toBeGreaterThan(0);
    // Last event should be final
    const last = events[events.length - 1];
    expect(last.final).toBe(true);
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

  it("7. A2A stream → grab taskId fast → background stream completes", async () => {
    // The real async pattern: open stream, grab taskId from first event (~1-2s),
    // then let the stream run in background until final event.
    // Note: tasks/get doesn't work after stream ends (LangGraph cleans up),
    // so the stream itself is the only reliable completion channel.
    const start = Date.now();
    let taskId: string | undefined;

    const stream = client.sendMessageStream("简要分析A股大盘趋势", {
      timeoutMs: 300_000,
    });

    // Step 1: Read first event → get taskId (must be fast)
    const first = await stream.next();
    expect(first.done).toBe(false);
    const firstRaw = first.value.raw as Record<string, unknown>;
    taskId = (firstRaw.id ?? firstRaw.taskId) as string | undefined;

    const submitMs = Date.now() - start;
    console.log(`[Async] Got taskId in ${submitMs}ms:`, taskId);
    expect(taskId).toBeDefined();
    expect(submitMs).toBeLessThan(10_000); // taskId must arrive within 10s

    // Step 2: Continue consuming stream until final event
    let lastMessage: Record<string, unknown> | undefined;
    let finalState: string | undefined;

    for await (const event of stream) {
      const msg = event.status?.message;
      if (msg && typeof msg === "object") {
        lastMessage = msg as Record<string, unknown>;
      }
      if (event.final) {
        finalState = event.status?.state;
        break;
      }
    }

    const totalMs = Date.now() - start;
    console.log(`[Async] Stream completed in ${totalMs}ms, state=${finalState}`);

    expect(finalState).toBe("completed");

    // Verify we got actual content from the stream
    if (lastMessage) {
      const parts = lastMessage.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((p: Record<string, unknown>) => typeof p.text === "string")
          .map((p: Record<string, unknown>) => String(p.text))
          .join("");
        console.log(`[Async] Got ${text.length} chars of content`);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it("8. A2A supports threaded conversation", async () => {
    // First message — establish context
    const resp1 = await client.sendMessage("记住这个：我关注茅台", {
      timeoutMs: 120_000,
    });
    expect(resp1.jsonrpc).toBe("2.0");

    // Extract threadId if available in result
    const result1 = resp1.result as Record<string, unknown> | undefined;
    const threadId = (result1?.thread_id ?? result1?.threadId ?? result1?.taskId) as
      | string
      | undefined;

    if (threadId) {
      // Second message — should have context
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
