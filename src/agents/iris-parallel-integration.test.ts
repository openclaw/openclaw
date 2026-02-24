/**
 * Integration test: iris-agent-core parallel tool execution in OpenClaw.
 *
 * Verifies that Agent (resolved to IrisAgent via pnpm.overrides) runs
 * multiple tool calls concurrently.  We mock streamSimple so no real
 * LLM call is made.
 */
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FAKE_MODEL = getModel("anthropic", "claude-opus-4-6");

function makeUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Build a streamFn that emits:
 *   1st call → three tool calls (tool_a, tool_b, tool_c) → stopReason "toolUse"
 *   2nd call → plain text "done" → stopReason "stop"
 */
function buildParallelStreamFn(calls: {
  ids: string[];
  toolNames: string[];
  onSecondCall?: () => void;
}) {
  let callCount = 0;
  return function mockStreamFn() {
    callCount++;
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      if (callCount === 1) {
        // First LLM turn: emit N tool calls
        const toolCalls = calls.ids.map((id, i) => ({
          type: "toolCall" as const,
          id,
          name: calls.toolNames[i] ?? id,
          arguments: {},
        }));
        stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: toolCalls,
            stopReason: "toolUse",
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: makeUsage(),
            timestamp: Date.now(),
          },
        });
      } else {
        // Subsequent turns: plain stop
        calls.onSecondCall?.();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "all done" }],
            stopReason: "stop",
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: makeUsage(),
            timestamp: Date.now(),
          },
        });
      }
      stream.end();
    });

    return stream;
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("IrisAgent parallel tool execution (integration)", () => {
  let agent: InstanceType<typeof Agent>;

  beforeEach(() => {
    // Reset real timers for each test
    vi.useRealTimers();
  });

  afterEach(() => {
    agent.abort();
  });

  it("Agent constructor resolves to IrisAgent", () => {
    agent = new Agent({});
    expect(agent.constructor.name).toBe("IrisAgent");
  });

  it("runs 3 tools concurrently — elapsed ≈ max(T) not sum(T)", async () => {
    const TOOL_DELAY_MS = 80;
    const timings: Record<string, { start: number; end: number }> = {};

    // Three tools, each taking TOOL_DELAY_MS
    const tools: AgentTool[] = ["tool_a", "tool_b", "tool_c"].map((name) => ({
      type: "function" as const,
      name,
      label: name,
      description: `test tool ${name}`,
      parameters: { type: "object" as const, properties: {} },
      execute: async (_id: string): Promise<AgentToolResult<void>> => {
        timings[name] = { start: Date.now(), end: 0 };
        await sleep(TOOL_DELAY_MS);
        timings[name].end = Date.now();
        return {
          content: [{ type: "text", text: `${name} done` } satisfies TextContent],
          details: undefined,
        };
      },
    }));

    agent = new Agent({
      initialState: {
        model: FAKE_MODEL,
        tools,
        systemPrompt: "",
        messages: [],
        isStreaming: false,
        streamMessage: null,
        pendingToolCalls: new Set(),
      },
      streamFn: buildParallelStreamFn({
        ids: ["id_a", "id_b", "id_c"],
        toolNames: ["tool_a", "tool_b", "tool_c"],
      }),
    });

    const wallStart = Date.now();
    await agent.prompt("run all tools");
    const elapsed = Date.now() - wallStart;

    // All three tools ran
    expect(Object.keys(timings).toSorted()).toEqual(["tool_a", "tool_b", "tool_c"]);

    // Parallel: wall-clock should be well under 2× a single tool delay
    // (allow generous headroom for CI jitter, but must beat sequential 3×80=240ms)
    expect(elapsed).toBeLessThan(TOOL_DELAY_MS * 2 + 50);

    // Start times should overlap: all tools started before any single one finished
    const starts = Object.values(timings).map((t) => t.start);
    const ends = Object.values(timings).map((t) => t.end);
    const maxStart = Math.max(...starts);
    const minEnd = Math.min(...ends);

    // If truly parallel, the last-to-start tool began BEFORE the first tool ended
    expect(maxStart).toBeLessThan(minEnd + 20); // allow 20ms slack
  }, 10_000);

  it("emits tool_execution_start for all tools before any tool_execution_end", async () => {
    const TOOL_DELAY_MS = 50;
    const events: string[] = [];

    const tools: AgentTool[] = ["x", "y", "z"].map((name) => ({
      type: "function" as const,
      name,
      label: name,
      description: `test ${name}`,
      parameters: { type: "object" as const, properties: {} },
      execute: async (): Promise<AgentToolResult<void>> => {
        await sleep(TOOL_DELAY_MS);
        return {
          content: [{ type: "text", text: `${name} done` } satisfies TextContent],
          details: undefined,
        };
      },
    }));

    agent = new Agent({
      initialState: {
        model: FAKE_MODEL,
        tools,
        systemPrompt: "",
        messages: [],
        isStreaming: false,
        streamMessage: null,
        pendingToolCalls: new Set(),
      },
      streamFn: buildParallelStreamFn({
        ids: ["idx", "idy", "idz"],
        toolNames: ["x", "y", "z"],
      }),
    });

    agent.subscribe((evt) => {
      if (evt.type === "tool_execution_start" || evt.type === "tool_execution_end") {
        events.push(`${evt.type}:${evt.toolName}`);
      }
    });

    await agent.prompt("go");

    // All 3 starts should appear before any end (parallel dispatch)
    const firstEnd = events.findIndex((e) => e.startsWith("tool_execution_end"));
    const lastStart = events
      .map((e, i) => (e.startsWith("tool_execution_start") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);

    expect(firstEnd).toBeGreaterThan(-1);
    expect(lastStart).toBeGreaterThan(-1);
    expect(lastStart).toBeLessThan(firstEnd); // all starts before first end
  }, 10_000);
});
