/**
 * Tests for agentLoopContinue, event stream ordering, and transformContext.
 */
import { EventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
} from "./types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeUserMessage(text = "go"): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeAssistantWithToolCall(id: string, name: string, args = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall" as const, id, name, arguments: args }],
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

function makeContext(tools: AgentTool[] = [], messages: AgentMessage[] = []): AgentContext {
  return { systemPrompt: "test", messages, tools };
}

async function collectEvents(loop: ReturnType<typeof agentLoop>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const evt of loop) {
    events.push(evt);
  }
  return events;
}

// ─── Event stream ordering ────────────────────────────────────────────────────

describe("event stream ordering", () => {
  it("emits agent_start before any turn events and agent_end last", async () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext();
    const loop = agentLoop([makeUserMessage()], ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    expect(events[0]?.type).toBe("agent_start");
    expect(events[events.length - 1]?.type).toBe("agent_end");
  });

  it("emits turn_start before and turn_end after assistant message events", async () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext();
    const loop = agentLoop([makeUserMessage()], ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    const types = events.map((e) => e.type);
    const turnStartIdx = types.indexOf("turn_start");
    const messageStartIdx = types.indexOf("message_start");
    const messageEndIdx = types.lastIndexOf("message_end");
    const turnEndIdx = types.indexOf("turn_end");

    expect(turnStartIdx).toBeGreaterThanOrEqual(0);
    expect(messageStartIdx).toBeGreaterThan(turnStartIdx);
    expect(messageEndIdx).toBeGreaterThan(messageStartIdx);
    expect(turnEndIdx).toBeGreaterThan(messageEndIdx);
  });

  it("emits tool_execution_start before tool_execution_end", async () => {
    const simpleTool: AgentTool = {
      name: "ping",
      label: "Ping",
      description: "Pings",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
    };

    const reply = makeAssistantWithToolCall("tc1", "ping");
    const streamFn = mockStreamFn([reply, doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([simpleTool]);
    const loop = agentLoop([makeUserMessage()], ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("tool_execution_start");
    const endIdx = types.indexOf("tool_execution_end");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("tool_execution_end carries the toolCallId and result", async () => {
    const simpleTool: AgentTool = {
      name: "echo",
      label: "Echo",
      description: "Returns args",
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: async (_id, args) => ({
        content: [{ type: "text", text: (args as { msg: string }).msg }],
        details: {},
      }),
    };

    const reply = makeAssistantWithToolCall("tc-echo", "echo", { msg: "hello" });
    const streamFn = mockStreamFn([reply, doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([simpleTool]);
    const loop = agentLoop([makeUserMessage()], ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    const endEvt = events.find((e) => e.type === "tool_execution_end");
    expect(endEvt?.toolCallId).toBe("tc-echo");
    expect(endEvt?.isError).toBe(false);
  });
});

// ─── agentLoopContinue ────────────────────────────────────────────────────────

describe("agentLoopContinue", () => {
  it("throws when context has no messages", () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext();
    expect(() => agentLoopContinue(ctx, cfg, undefined, streamFn)).toThrow(
      "Cannot continue: no messages in context",
    );
  });

  it("throws when last message is assistant role", () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([], [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    ] as AgentMessage[]);
    expect(() => agentLoopContinue(ctx, cfg, undefined, streamFn)).toThrow(
      "Cannot continue from message role: assistant",
    );
  });

  it("runs from existing user message context and emits agent events", async () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([], [makeUserMessage("existing message")]);
    const loop = agentLoopContinue(ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    expect(types[0]).toBe("agent_start");
    expect(types[types.length - 1]).toBe("agent_end");
  });

  it("does not push prompt messages to the event stream (no message_start for input)", async () => {
    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([], [makeUserMessage("existing")]);
    const loop = agentLoopContinue(ctx, cfg, undefined, streamFn);
    const events = await collectEvents(loop);

    // agentLoopContinue should not emit message_start for the existing user message
    // (only agentLoop emits message_start for the newly added prompts)
    const messageStartEvents = events.filter((e) => e.type === "message_start");
    // The only message_start should be for the assistant reply, not the pre-existing user turn
    for (const evt of messageStartEvents) {
      const msg = evt.message;
      expect((msg as { role: string }).role).toBe("assistant");
    }
  });

  it("calls tools from the continued context", async () => {
    let executed = false;
    const tool: AgentTool = {
      name: "act",
      label: "Act",
      description: "Does something",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    };

    const reply = makeAssistantWithToolCall("tc-act", "act");
    const streamFn = mockStreamFn([reply, doneMsg]);
    const cfg = makeConfig(streamFn);
    const ctx = makeContext([tool], [makeUserMessage("please act")]);
    const loop = agentLoopContinue(ctx, cfg, undefined, streamFn);
    await collectEvents(loop);

    expect(executed).toBe(true);
  });
});

// ─── transformContext ─────────────────────────────────────────────────────────

describe("transformContext hook", () => {
  it("receives messages before they are sent to the LLM", async () => {
    const seenMessages: unknown[] = [];
    const transformContext = vi.fn(async (msgs: AgentMessage[]) => {
      seenMessages.push(...msgs);
      return msgs;
    });

    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn, { transformContext });
    const ctx = makeContext();
    const loop = agentLoop([makeUserMessage("transform me")], ctx, cfg, undefined, streamFn);
    await collectEvents(loop);

    expect(transformContext).toHaveBeenCalled();
    expect(seenMessages.some((m) => (m as { role: string }).role === "user")).toBe(true);
  });

  it("can filter messages before LLM receives them", async () => {
    const capturedLlmMessages: unknown[][] = [];

    const streamFn = async (_model: Model<string>, ctx: unknown, _opts: unknown) => {
      capturedLlmMessages.push(((ctx as { messages?: unknown[] })?.messages ?? []).slice());
      const msg = doneMsg;
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

    // transformContext strips "secret" text blocks before sending to LLM
    const transformContext = async (msgs: AgentMessage[]) =>
      msgs.filter((m) => {
        if (m.role !== "user") {
          return true;
        }
        const content = (m as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
        return !content.some((block) => block.text === "secret");
      });

    const cfg = makeConfig(streamFn as ReturnType<typeof mockStreamFn>, { transformContext });
    const ctx = makeContext();
    const loop = agentLoop(
      [
        makeUserMessage("public message"),
        { role: "user", content: [{ type: "text", text: "secret" }], timestamp: Date.now() },
      ],
      ctx,
      cfg,
      undefined,
      streamFn as ReturnType<typeof mockStreamFn>,
    );
    await collectEvents(loop);

    // LLM should not have received the secret message
    const firstCall = capturedLlmMessages[0] ?? [];
    const hasSecret = firstCall.some(
      (m) =>
        (m as { role?: string; content?: Array<{ text?: string }> }).role === "user" &&
        ((m as { content?: Array<{ text?: string }> }).content ?? []).some(
          (b) => b.text === "secret",
        ),
    );
    expect(hasSecret).toBe(false);
  });

  it("is called with AbortSignal as second argument", async () => {
    let receivedSignal: AbortSignal | undefined;
    const transformContext = vi.fn(async (msgs: AgentMessage[], signal?: AbortSignal) => {
      receivedSignal = signal;
      return msgs;
    });

    const streamFn = mockStreamFn([doneMsg]);
    const cfg = makeConfig(streamFn, { transformContext });
    const ctx = makeContext();
    const abortController = new AbortController();
    const loop = agentLoop([makeUserMessage()], ctx, cfg, abortController.signal, streamFn);
    await collectEvents(loop);

    expect(transformContext).toHaveBeenCalled();
    expect(receivedSignal).toBe(abortController.signal);
  });
});
