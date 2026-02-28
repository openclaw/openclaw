/**
 * Edge-case tests for cross-turn caching, key stability, TTL expiration,
 * error result isolation, and Semaphore FIFO ordering.
 *
 * Tests are written against the public agentLoop API so no internal symbols
 * need to be exported.
 */
import { EventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "./agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentTool, AgentToolResult } from "./types.js";

// ─── helpers (mirrors features.test.ts helpers) ───────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assistantWithToolCalls(
  ...calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "toolCall" as const,
      id: c.id,
      name: c.name,
      arguments: c.args ?? {},
    })),
    stopReason: "tool_use",
    timestamp: Date.now(),
  };
}

const doneMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  stopReason: "end_turn",
  timestamp: Date.now(),
};

function mockStreamFn(replies: AssistantMessage[]) {
  let callCount = 0;
  return async (_model: Model<string>, _ctx: unknown, _opts: unknown) => {
    const msg = replies[callCount % replies.length];
    callCount++;
    const stream = new EventStream<
      Parameters<ReturnType<typeof EventStream.prototype.push>>[0],
      AssistantMessage
    >(
      (e: { type: string }) => e.type === "done",
      () => msg,
    );
    stream.push({ type: "done", partial: msg });
    stream.end(msg);
    return stream as ReturnType<typeof import("@mariozechner/pi-ai").streamSimple>;
  };
}

function makeConfig(
  streamFn: ReturnType<typeof mockStreamFn>,
  extra?: Partial<AgentLoopConfig>,
): AgentLoopConfig {
  return {
    model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" } as Model<string>,
    convertToLlm: (msgs) => msgs,
    apiKey: "test-key",
    ...extra,
  };
}

function makeContext(tools: AgentTool[]): AgentContext {
  return { systemPrompt: "test", messages: [], tools };
}

async function drainLoop(
  tools: AgentTool[],
  replies: AssistantMessage[],
  config?: Partial<AgentLoopConfig>,
) {
  const streamFn = mockStreamFn(replies);
  const cfg = makeConfig(streamFn, config);
  const ctx = makeContext(tools);
  const loop = agentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
    ctx,
    cfg,
    undefined,
    streamFn,
  );
  for await (const _evt of loop) {
    /* drain */
  }
}

// ─── Stable JSON key ordering ──────────────────────────────────────────────────

describe("stable JSON cache key ordering", () => {
  it("treats args with the same keys in different order as the same cache key", async () => {
    let callCount = 0;
    const tool: AgentTool = {
      name: "search",
      label: "Search",
      description: "search tool",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "result" }], details: {} };
      },
    };

    // Two calls in a single batch: same semantic args, different key order
    const batchMsg = assistantWithToolCalls(
      { id: "tc1", name: "search", args: { query: "foo", limit: 10 } },
      { id: "tc2", name: "search", args: { limit: 10, query: "foo" } },
    );

    await drainLoop([tool], [batchMsg, doneMsg], { toolCacheMs: 60_000 });

    // Key-order-invariant → deduplicated → executed only once
    expect(callCount).toBe(1);
  });

  it("treats args with different values as distinct cache keys", async () => {
    let callCount = 0;
    const tool: AgentTool = {
      name: "search",
      label: "Search",
      description: "search tool",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "result" }], details: {} };
      },
    };

    const batchMsg = assistantWithToolCalls(
      { id: "tc1", name: "search", args: { query: "foo" } },
      { id: "tc2", name: "search", args: { query: "bar" } },
    );

    await drainLoop([tool], [batchMsg, doneMsg], { toolCacheMs: 60_000 });

    expect(callCount).toBe(2);
  });
});

// ─── Cache TTL expiration ──────────────────────────────────────────────────────

describe("cache TTL expiration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a cache hit when within TTL", async () => {
    let callCount = 0;
    const tool: AgentTool = {
      name: "fetch",
      label: "Fetch",
      description: "fetches data",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "data" }], details: {} };
      },
    };

    let followUpCalled = false;
    const turn1 = assistantWithToolCalls({ id: "tc1", name: "fetch", args: { url: "x" } });
    const turn2 = assistantWithToolCalls({ id: "tc2", name: "fetch", args: { url: "x" } });
    const streamFn = mockStreamFn([turn1, turn2, doneMsg]);
    let followUpDone = false;

    const cfg = makeConfig(streamFn, {
      toolCacheMs: 5_000, // 5 s TTL
      getFollowUpMessages: async () => {
        if (!followUpDone) {
          followUpDone = true;
          followUpCalled = true;
          // Advance time by 1 s — well within the 5 s TTL
          vi.advanceTimersByTime(1_000);
          return [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "again" }],
              timestamp: Date.now(),
            },
          ];
        }
        return [];
      },
    });

    const loop = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
      makeContext([tool]),
      cfg,
      undefined,
      streamFn,
    );
    for await (const _evt of loop) {
      /* drain */
    }

    expect(followUpCalled).toBe(true);
    expect(callCount).toBe(1); // second call served from cache
  });

  it("re-executes after TTL expires", async () => {
    let callCount = 0;
    const tool: AgentTool = {
      name: "fetch",
      label: "Fetch",
      description: "fetches data",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "data" }], details: {} };
      },
    };

    const turn1 = assistantWithToolCalls({ id: "tc1", name: "fetch", args: { url: "x" } });
    const turn2 = assistantWithToolCalls({ id: "tc2", name: "fetch", args: { url: "x" } });
    const streamFn = mockStreamFn([turn1, turn2, doneMsg]);
    let followUpDone = false;

    const cfg = makeConfig(streamFn, {
      toolCacheMs: 500, // 500 ms TTL
      getFollowUpMessages: async () => {
        if (!followUpDone) {
          followUpDone = true;
          // Advance time by 1 s — past the 500 ms TTL
          vi.advanceTimersByTime(1_000);
          return [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "again" }],
              timestamp: Date.now(),
            },
          ];
        }
        return [];
      },
    });

    const loop = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
      makeContext([tool]),
      cfg,
      undefined,
      streamFn,
    );
    for await (const _evt of loop) {
      /* drain */
    }

    expect(callCount).toBe(2); // cache expired → re-executed
  });

  it("toolCacheMs=-1 never expires (session-scoped)", async () => {
    let callCount = 0;
    const tool: AgentTool = {
      name: "fetch",
      label: "Fetch",
      description: "fetches data",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "data" }], details: {} };
      },
    };

    const turn1 = assistantWithToolCalls({ id: "tc1", name: "fetch", args: { url: "x" } });
    const turn2 = assistantWithToolCalls({ id: "tc2", name: "fetch", args: { url: "x" } });
    const streamFn = mockStreamFn([turn1, turn2, doneMsg]);
    let followUpDone = false;

    const cfg = makeConfig(streamFn, {
      toolCacheMs: -1, // session-scoped: never expires
      getFollowUpMessages: async () => {
        if (!followUpDone) {
          followUpDone = true;
          // Advance time by 1 year — still shouldn't expire
          vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1_000);
          return [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "again" }],
              timestamp: Date.now(),
            },
          ];
        }
        return [];
      },
    });

    const loop = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
      makeContext([tool]),
      cfg,
      undefined,
      streamFn,
    );
    for await (const _evt of loop) {
      /* drain */
    }

    expect(callCount).toBe(1); // never re-executes
  });
});

// ─── Error result not cached ───────────────────────────────────────────────────

describe("error results are not cached", () => {
  it("retries a failing cacheable tool on the next turn", async () => {
    let callCount = 0;
    const flakeyTool: AgentTool = {
      name: "flakey",
      label: "Flakey",
      description: "fails first then succeeds",
      cacheable: true,
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (): Promise<AgentToolResult<void>> => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient failure");
        }
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    };

    const turn1 = assistantWithToolCalls({ id: "tc1", name: "flakey", args: { x: 1 } });
    const turn2 = assistantWithToolCalls({ id: "tc2", name: "flakey", args: { x: 1 } });
    const streamFn = mockStreamFn([turn1, turn2, doneMsg]);
    let followUpDone = false;

    const cfg = makeConfig(streamFn, {
      toolCacheMs: 60_000,
      getFollowUpMessages: async () => {
        if (!followUpDone) {
          followUpDone = true;
          return [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "retry" }],
              timestamp: Date.now(),
            },
          ];
        }
        return [];
      },
    });

    const loop = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
      makeContext([flakeyTool]),
      cfg,
      undefined,
      streamFn,
    );
    for await (const _evt of loop) {
      /* drain */
    }

    // Failed first call was not cached → second call executed (count=2)
    expect(callCount).toBe(2);
  });
});

// ─── Semaphore FIFO ordering ───────────────────────────────────────────────────

describe("Semaphore FIFO ordering via maxParallelTools", () => {
  it("processes queued tools in FIFO order when limit is 1", async () => {
    const order: number[] = [];
    const TOOL_COUNT = 4;

    const tools: AgentTool[] = Array.from({ length: TOOL_COUNT }, (_, idx) => ({
      name: `t${idx}`,
      label: `T${idx}`,
      description: `tool ${idx}`,
      parameters: { type: "object" as const, properties: {}, required: [] },
      execute: async (): Promise<AgentToolResult<void>> => {
        order.push(idx);
        await sleep(5);
        return { content: [{ type: "text" as const, text: `${idx}` }], details: undefined };
      },
    }));

    const batchMsg = assistantWithToolCalls(
      ...Array.from({ length: TOOL_COUNT }, (_, idx) => ({ id: `tc${idx}`, name: `t${idx}` })),
    );

    // With limit=1 tools run sequentially — they should execute in submission order
    await drainLoop(tools, [batchMsg, doneMsg], { maxParallelTools: 1 });

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("all tools complete when limit equals tool count", async () => {
    const completed = new Set<number>();
    const TOOL_COUNT = 5;

    const tools: AgentTool[] = Array.from({ length: TOOL_COUNT }, (_, idx) => ({
      name: `p${idx}`,
      label: `P${idx}`,
      description: `parallel tool ${idx}`,
      parameters: { type: "object" as const, properties: {}, required: [] },
      execute: async (): Promise<AgentToolResult<void>> => {
        await sleep(10);
        completed.add(idx);
        return { content: [{ type: "text" as const, text: `${idx}` }], details: undefined };
      },
    }));

    const batchMsg = assistantWithToolCalls(
      ...Array.from({ length: TOOL_COUNT }, (_, idx) => ({ id: `tc${idx}`, name: `p${idx}` })),
    );

    await drainLoop(tools, [batchMsg, doneMsg], { maxParallelTools: TOOL_COUNT });

    expect(completed.size).toBe(TOOL_COUNT);
  });
});

// ─── Tool not found ────────────────────────────────────────────────────────────

describe("tool not found", () => {
  it("produces a tool_execution_end with isError=true for an unknown tool name", async () => {
    const reply = assistantWithToolCalls({ id: "tc1", name: "nonexistent_tool" });
    const streamFn = mockStreamFn([reply, doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([]); // no tools registered

    const loop = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
      ctx,
      cfg,
      undefined,
      streamFn,
    );

    const events: Array<{ type: string; isError?: boolean }> = [];
    for await (const evt of loop) {
      events.push(evt);
    }

    const endEvt = events.find((e) => e.type === "tool_execution_end");
    expect(endEvt).toBeDefined();
    expect((endEvt as { isError: boolean }).isError).toBe(true);
  });
});
