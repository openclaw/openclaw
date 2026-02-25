/**
 * Feature tests for timeout, caching, and deduplication.
 *
 * These tests exercise the three features added to executeToolCallsParallel
 * by driving agentLoop with a mocked streamFn that emits deterministic
 * assistant messages containing tool calls.
 */
import { EventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "./agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentTool } from "./types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a minimal AssistantMessage with tool calls. */
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

/**
 * Build a mocked streamFn that replays a fixed sequence of AssistantMessages.
 * The final message in the sequence should have no tool calls (stopReason=end_turn).
 */
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

/** Minimal AgentLoopConfig. */
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

/** Minimal AgentContext. */
function makeContext(tools: AgentTool[]): AgentContext {
  return {
    systemPrompt: "test",
    messages: [],
    tools,
  };
}

/** Collect all events from an agentLoop run. */
async function runLoop(
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
  const events: string[] = [];
  for await (const evt of loop) {
    events.push(evt.type);
  }
  return events;
}

// ─── helpers for building realistic AssistantMessage (no tool calls = done) ────

const doneMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  stopReason: "end_turn",
  timestamp: Date.now(),
};

// ─── Timeout ──────────────────────────────────────────────────────────────────

describe("per-tool timeout", () => {
  it("aborts a tool that exceeds toolTimeoutMs", async () => {
    let aborted = false;
    const slowTool: AgentTool = {
      name: "slow",
      label: "Slow Tool",
      description: "Takes forever",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_id, _args, signal) => {
        try {
          await new Promise<void>((_res, rej) => {
            const h = setTimeout(() => rej(new Error("should have been aborted")), 5000);
            signal?.addEventListener("abort", () => {
              clearTimeout(h);
              aborted = true;
              rej(new DOMException("AbortError", "AbortError"));
            });
          });
        } catch {
          // swallow
        }
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    };

    const reply1 = assistantWithToolCalls({ id: "tc1", name: "slow" });
    const events = await runLoop([slowTool], [reply1, doneMsg], { toolTimeoutMs: 100 });

    expect(aborted).toBe(true);
    expect(events).toContain("tool_execution_end");
  });
});

// ─── Caching ──────────────────────────────────────────────────────────────────

describe("cross-turn tool caching", () => {
  it("executes a cacheable tool only once across two turns", async () => {
    let callCount = 0;
    const cachedTool: AgentTool = {
      name: "read_file",
      label: "Read File",
      description: "Reads a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      cacheable: true,
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: `content-${callCount}` }], details: {} };
      },
    };

    // Turn 1: call read_file("test.txt")
    const turn1 = assistantWithToolCalls({
      id: "tc1",
      name: "read_file",
      args: { path: "test.txt" },
    });
    // Turn 2: same call again (LLM asks a second time in the same session)
    const turn2 = assistantWithToolCalls({
      id: "tc2",
      name: "read_file",
      args: { path: "test.txt" },
    });

    // Use a shared toolCache (simulates a single agent run spanning multiple LLM turns)
    // We do this by running TWO separate agentLoop calls sharing the same toolCache.
    // The real way: getSteeringMessages / getFollowUpMessages chain turns internally.
    // For a simpler test, we call executeToolCallsParallel-equivalent by running
    // two back-to-back agentLoop runs is tricky; instead test via getFollowUpMessages.

    let followUpCalled = false;
    const tool = cachedTool;
    const streamFn = mockStreamFn([turn1, turn2, doneMsg]);
    let followUpReturned = false;
    const cfg = makeConfig(streamFn, {
      toolCacheMs: 60_000, // 1 min
      getFollowUpMessages: async () => {
        if (!followUpReturned) {
          followUpReturned = true;
          followUpCalled = true;
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
    const ctx = makeContext([tool]);
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

    // Tool should have been executed only once even though it was called in two turns
    expect(followUpCalled).toBe(true);
    expect(callCount).toBe(1); // second call served from cache
  });
});

// ─── Batch deduplication ──────────────────────────────────────────────────────

describe("within-batch deduplication", () => {
  it("executes a duplicated tool call only once in the same batch", async () => {
    let callCount = 0;
    const readTool: AgentTool = {
      name: "read_file",
      label: "Read File",
      description: "Reads a file",
      cacheable: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        callCount++;
        await sleep(20);
        return { content: [{ type: "text", text: "data" }], details: {} };
      },
    };

    // Same tool + same args, two different toolCallIds in ONE assistant message
    const batchMsg = assistantWithToolCalls(
      { id: "tc1", name: "read_file", args: { path: "foo.txt" } },
      { id: "tc2", name: "read_file", args: { path: "foo.txt" } },
    );

    await runLoop([readTool], [batchMsg, doneMsg], { toolCacheMs: 60_000 });

    // Both tc1 and tc2 share the same (name, args) key — should execute once
    expect(callCount).toBe(1);
  });

  it("executes distinct args separately even for the same tool name", async () => {
    let callCount = 0;
    const readTool: AgentTool = {
      name: "read_file",
      label: "Read File",
      description: "Reads a file",
      cacheable: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        callCount++;
        return { content: [{ type: "text", text: "data" }], details: {} };
      },
    };

    const batchMsg = assistantWithToolCalls(
      { id: "tc1", name: "read_file", args: { path: "foo.txt" } },
      { id: "tc2", name: "read_file", args: { path: "bar.txt" } },
    );

    await runLoop([readTool], [batchMsg, doneMsg], { toolCacheMs: 60_000 });

    // Different args → two separate executions
    expect(callCount).toBe(2);
  });
});
