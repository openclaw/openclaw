import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import {
  appendAssistantThinking,
  readAssistantThinkingAppend,
} from "@openclaw/llm-core/event-stream";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { runAgentLoop } from "./agent-loop.js";
import { config, makeAssistantMessage, user } from "./agent-loop.test-support.js";
import type { Message, Model } from "./llm.js";
import type { AgentEvent } from "./types.js";

// End-to-end regression for the partial-snapshot aliasing defect, through the
// real consumer: runAgentLoop drives the real openai-responses transport over
// a local SSE server, and the agent loop consumes the stream with its
// replace-or-append contract. Before the transport detached text snapshots,
// every message's first text delta was applied twice in the live
// message_update projection (the closing snapshot healed the stored message,
// so the doubling was transient and easy to miss). Text blocks are the only
// blocks at risk — agent-core appends only text_delta; every other delta kind
// carries its own partial and is replaced wholesale.

const WIRE_TEXT = "夜班巡检记录：雾笛、备用灯与无线电均正常。";
const DELTAS = ["夜班巡检记录：", "雾笛、备用灯与无", "线电均正常。"];

function sse(events: readonly unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function providerEvents(): unknown[] {
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    ...DELTAS.map((delta) => ({
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: "msg_1",
      content_index: 0,
      text: WIRE_TEXT,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text: WIRE_TEXT }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        end_turn: true,
        output: [
          {
            type: "message",
            id: "msg_1",
            status: "completed",
            content: [{ type: "output_text", text: WIRE_TEXT }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    },
  ];
}

async function startResponsesServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(providerEvents()));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

function messageUpdateTexts(events: readonly AgentEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "message_update" || !("content" in event.message)) {
      continue;
    }
    const blocks = typeof event.message.content === "string" ? [] : event.message.content;
    for (const block of blocks) {
      if (block.type === "text" && block.text.length > 0) {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

describe("agent loop over openai-responses partial snapshots", () => {
  it("live message updates grow strictly, never doubling the opening", async () => {
    const { server, port } = await startResponsesServer();
    try {
      const model: Model<"openai-responses"> = {
        id: "test-model",
        name: "Test model",
        provider: "volcengine-plan",
        api: "openai-responses",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      };
      const events: AgentEvent[] = [];
      const result = await runAgentLoop(
        [{ role: "user", content: "Report the night watch log.", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [] },
        {
          model,
          convertToLlm: (messages) => messages as Message[],
        },
        (event) => {
          events.push(event);
        },
        undefined,
        (_loopModel, context, options) =>
          streamOpenAIResponses(model, context, { ...options, apiKey: "test-key" }),
      );

      // Every live update must be a strict prefix of the wire text — a
      // doubled opening surfaces here as text that is NOT a wire prefix.
      const updates = messageUpdateTexts(events);
      expect(updates.length).toBeGreaterThan(0);
      for (const text of updates) {
        expect(WIRE_TEXT.startsWith(text)).toBe(true);
      }
      // Monotonic growth: each update extends the previous one.
      for (const [index, text] of updates.entries()) {
        if (index === 0) {
          continue;
        }
        const previous = updates[index - 1] ?? "";
        expect(text.startsWith(previous)).toBe(true);
      }
      // The final live update must carry the complete wire text exactly once.
      expect(updates.at(-1)).toBe(WIRE_TEXT);
      void result;
    } finally {
      server.close();
    }
  });
});

// Exercise batching through the agent's real event boundary, with
// a paced provider so the stream's existing unread-queue merging cannot help.
async function streamingFixture(observe?: (event: AgentEvent) => void) {
  const stream = createAssistantMessageEventStream();
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  const message = makeAssistantMessage([{ type: "text", text: "" }]);
  const result = runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [] },
    config,
    (event) => {
      observe?.(event);
      events.push(structuredClone(event));
    },
    abort.signal,
    () => stream,
  );
  stream.push({ type: "start", partial: message });
  await vi.advanceTimersByTimeAsync(0);
  const updates = () =>
    events.flatMap((event) =>
      event.type === "message_update" ? [event.assistantMessageEvent] : [],
    );
  const finish = async () => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    await result;
  };
  return { stream, events, abort, message, result, updates, finish };
}

it("batches paced text and native reasoning within 32 ms and flushes block boundaries", async () => {
  vi.useFakeTimers();
  try {
    const appends: Array<string | undefined> = [];
    let previous = "";
    const run = await streamingFixture((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "thinking_delta"
      ) {
        const delta = event.assistantMessageEvent;
        const block = delta.partial.content[delta.contentIndex];
        if (block?.type === "thinking") {
          appends.push(readAssistantThinkingAppend(block, previous));
          previous = block.thinking;
        }
      }
    });
    for (const delta of ["one", " two", " three"]) {
      run.stream.push({ type: "text_delta", contentIndex: 0, delta });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(run.updates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(run.updates()).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "one two three" },
    ]);
    const thinking = { type: "thinking" as const, thinking: "" };
    run.message.content.push(thinking);
    run.stream.push({ type: "thinking_start", contentIndex: 1, partial: run.message });
    for (const delta of ["reason", " carefully"]) {
      appendAssistantThinking(thinking, delta);
      run.stream.push({ type: "thinking_delta", contentIndex: 1, delta, partial: run.message });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(12);
    appendAssistantThinking(thinking, " again");
    run.stream.push({
      type: "thinking_delta",
      contentIndex: 1,
      delta: " again",
      partial: run.message,
    });
    await vi.advanceTimersByTimeAsync(10);
    run.stream.push({
      type: "thinking_end",
      contentIndex: 1,
      content: thinking.thinking,
      partial: run.message,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.updates().map((event) => event.type)).toEqual([
      "text_delta",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
    ]);
    expect(run.updates()[2]).toMatchObject({
      delta: "reason carefully",
      partial: { content: [{ type: "text" }, { thinking: "reason carefully" }] },
    });
    expect(appends).toEqual(["reason carefully", " again"]);
    run.message.content[0] = { type: "text", text: "one two three" };
    await run.finish();
    expect(
      run.events.filter(
        (event) => event.type === "message_end" && event.message.role === "assistant",
      ),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps snapshot replacements and tool events immediate and ordered", async () => {
  vi.useFakeTimers();
  try {
    const run = await streamingFixture();
    run.stream.push({ type: "text_delta", contentIndex: 0, delta: "old" });
    await vi.advanceTimersByTimeAsync(10);
    const replacement = makeAssistantMessage([{ type: "text", text: "new" }]);
    run.stream.push({ type: "text_delta", contentIndex: 0, delta: "", partial: replacement });
    const tool = { type: "toolCall" as const, id: "call", name: "fixture", arguments: {} };
    const withTool = makeAssistantMessage([...replacement.content, tool]);
    run.stream.push({ type: "toolcall_start", contentIndex: 1, partial: withTool });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.updates().map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "toolcall_start",
    ]);
    const updates = run.events.filter((event) => event.type === "message_update");
    expect(updates[0]?.message).toMatchObject({ content: [{ type: "text", text: "old" }] });
    expect(updates[1]?.message).toMatchObject({ content: [{ type: "text", text: "new" }] });
    const reasoning = makeAssistantMessage([{ type: "thinking", thinking: "replacement" }]);
    run.stream.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "replacement",
      partial: reasoning,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.updates().at(-1)).toMatchObject({ type: "thinking_delta", delta: "replacement" });
    expect(vi.getTimerCount()).toBe(0);
    await run.finish();
  } finally {
    vi.useRealTimers();
  }
});

it("flushes buffered text on abort without waiting for the batch deadline", async () => {
  vi.useFakeTimers();
  try {
    const run = await streamingFixture();
    run.stream.push({ type: "text_delta", contentIndex: 0, delta: "retained" });
    await vi.advanceTimersByTimeAsync(10);
    expect(run.updates()).toEqual([]);
    run.abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.updates()).toEqual([{ type: "text_delta", contentIndex: 0, delta: "retained" }]);
    run.stream.push({
      type: "error",
      reason: "aborted",
      error: {
        ...run.message,
        content: [{ type: "text", text: "retained" }],
        stopReason: "aborted",
      },
    });
    run.stream.end();
    await run.result;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not hold a failed listener open behind a provider that ignores abort", async () => {
  vi.useFakeTimers();
  try {
    const stream = createAssistantMessageEventStream();
    const message = makeAssistantMessage([{ type: "text", text: "" }]);
    const result = runAgentLoop(
      [user()],
      { systemPrompt: "", messages: [], tools: [] },
      config,
      (event) => {
        if (event.type === "message_update") {
          throw new Error("listener failed");
        }
      },
      undefined,
      () => stream,
    );
    const failed = expect(result).rejects.toThrow("listener failed");
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "text" });
    await vi.advanceTimersByTimeAsync(32);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    stream.end(message);
  } finally {
    vi.useRealTimers();
  }
});
