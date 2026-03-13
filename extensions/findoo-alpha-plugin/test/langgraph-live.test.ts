/**
 * L2 — Findoo LangGraph Live Integration Test
 *
 * Tests real LangGraph API communication with the remote strategy-agent (43.128.100.43:5085).
 * Requires network access to PRD server.
 *
 * Run: LIVE=1 npx vitest run extensions/findoo-alpha-plugin/test/langgraph-live.test.ts
 */
import { describe, expect, it } from "vitest";
import { LangGraphClient, type LangGraphStreamEvent } from "../src/langgraph-client.js";

const SKIP = !process.env.LIVE;
const STRATEGY_AGENT_URL = process.env.STRATEGY_AGENT_URL ?? "http://43.128.100.43:5085";
const ASSISTANT_ID = process.env.STRATEGY_ASSISTANT_ID ?? "d2310a07-b552-453c-a8bb-7b9b86de6b23";

describe.skipIf(SKIP)("L2 — Findoo LangGraph Live", { timeout: 300_000 }, () => {
  const client = new LangGraphClient(STRATEGY_AGENT_URL, ASSISTANT_ID);

  it("1. /ok health check", async () => {
    const ok = await client.healthCheck();
    expect(ok).toBe(true);
  });

  it("2. /assistants/search returns assistants", async () => {
    const resp = await fetch(`${STRATEGY_AGENT_URL}/assistants/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    expect(resp.ok).toBe(true);
    const assistants = (await resp.json()) as Array<{ assistant_id: string; graph_id: string }>;
    expect(Array.isArray(assistants)).toBe(true);
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants[0]).toHaveProperty("assistant_id");
  });

  it("3. createThread returns thread_id", async () => {
    const thread = await client.createThread({ test: true });
    expect(thread.thread_id).toBeDefined();
    expect(typeof thread.thread_id).toBe("string");
    console.log("[LangGraph] Created thread:", thread.thread_id);
  });

  it("4. createStreamingRun + parseSSE returns events", async () => {
    const thread = await client.createThread();
    const resp = await client.createStreamingRun(thread.thread_id, [
      { role: "user", content: "你好，请简要介绍你的能力" },
    ]);

    const events: LangGraphStreamEvent[] = [];
    for await (const event of LangGraphClient.parseSSE(resp.body!)) {
      events.push(event);
      if (events.length >= 20) break; // cap for test speed
    }

    expect(events.length).toBeGreaterThan(0);
    console.log(
      "[LangGraph] Received events:",
      events.map((e) => e.event),
    );
    console.log(
      "[LangGraph] First event data preview:",
      JSON.stringify(events[0]?.data).slice(0, 300),
    );
  });

  it("5. streaming run with context", async () => {
    const thread = await client.createThread();
    const resp = await client.createStreamingRun(
      thread.thread_id,
      [{ role: "user", content: "查看这只股票的基本情况" }],
      { symbol: "600519.SS", market: "cn" },
    );

    const events: LangGraphStreamEvent[] = [];
    for await (const event of LangGraphClient.parseSSE(resp.body!)) {
      events.push(event);
      if (events.length >= 20) break;
    }

    expect(events.length).toBeGreaterThan(0);
    console.log("[LangGraph with context] Events count:", events.length);
  });

  it("6. getThreadState returns state", async () => {
    const thread = await client.createThread();
    const state = await client.getThreadState(thread.thread_id);
    expect(state).toBeDefined();
    console.log("[LangGraph] Thread state preview:", JSON.stringify(state).slice(0, 300));
  });

  it("7. threaded conversation (reuse thread)", async () => {
    const thread = await client.createThread();

    // First message
    const resp1 = await client.createStreamingRun(thread.thread_id, [
      { role: "user", content: "记住这个：我关注茅台" },
    ]);
    const events1: LangGraphStreamEvent[] = [];
    for await (const event of LangGraphClient.parseSSE(resp1.body!)) {
      events1.push(event);
    }
    expect(events1.length).toBeGreaterThan(0);

    // Follow-up on same thread
    const resp2 = await client.createStreamingRun(thread.thread_id, [
      { role: "user", content: "我刚才说关注什么？" },
    ]);
    const events2: LangGraphStreamEvent[] = [];
    for await (const event of LangGraphClient.parseSSE(resp2.body!)) {
      events2.push(event);
    }
    expect(events2.length).toBeGreaterThan(0);
    console.log("[LangGraph Thread] Follow-up events:", events2.length);
  });
});
