import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  config,
  captureAgentLoop,
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  reply,
  user,
} from "./agent-loop.test-support.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
} from "./llm.js";
import { distinctRecordOutputs, variedRows } from "./repetition-guard.test-fixtures.js";
import type { AgentToolCall, StreamFn } from "./types.js";

const loop = "Please provide more input. ".repeat(800);
const marker = "[Repetitive output stopped]";

function expectResponse(
  { result, events, requests }: Awaited<ReturnType<typeof runResponse>>,
  content: AssistantMessage["content"],
  stopped = false,
) {
  expect(requests).toBe(1);
  expect(result.at(-1)).toMatchObject({
    stopReason: stopped ? "error" : "stop",
    content,
    ...(stopped ? { errorCode: "openclaw_repetitive_output" } : {}),
  });
  if (stopped) {
    expect(result.at(-1)).toHaveProperty("providerReplay", undefined);
  }
  expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
    message: { content, ...(stopped ? { providerReplay: undefined } : {}) },
  });
}

async function runResponse(
  content: AssistantMessage["content"],
  enabled = true,
  terminalOnly = false,
  initialText?: string,
  incrementalText = false,
) {
  let requests = 0;
  const streamFn: StreamFn = () => {
    requests += 1;
    const events: AssistantMessageEvent[] = [];
    const message = makeAssistantMessage(content);
    message.providerReplay = {
      v: 1,
      type: "test-checkpoint",
      data: "opaque state containing discarded output",
      api: message.api,
      provider: message.provider,
      model: message.model,
    };
    if (!terminalOnly || initialText !== undefined) {
      events.push({ type: "start", partial: makeAssistantMessage([]) });
    }
    if (initialText !== undefined) {
      events.push({
        type: "text_delta",
        contentIndex: 0,
        delta: initialText,
        partial: makeAssistantMessage([{ type: "text", text: initialText }]),
      });
    }
    for (const [contentIndex, block] of (terminalOnly ? [] : content).entries()) {
      const snapshot = { contentIndex, partial: message };
      if (block.type === "text" && incrementalText) {
        for (let offset = 0; offset < block.text.length; offset += 1024) {
          events.push({
            type: "text_delta",
            contentIndex,
            delta: block.text.slice(offset, offset + 1024),
          });
        }
      } else if (block.type === "text") {
        events.push({ type: "text_delta", ...snapshot, delta: block.text });
      } else if (block.type === "thinking") {
        events.push({ type: "thinking_delta", ...snapshot, delta: block.thinking });
      }
    }
    return reply(message, events);
  };
  const run = captureAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [] },
    { ...config, repetitionGuard: () => enabled },
    undefined,
    streamFn,
  );
  return { result: await run.result, events: run.events, requests };
}

describe("repetition stop at the stream owner", () => {
  it.each(distinctRecordOutputs)("delivers $name without truncation", async ({ text }) => {
    const content: AssistantMessage["content"] = [{ type: "text", text }];
    expectResponse(await runResponse(content), content);
  });

  it.each<{
    kind: string;
    terminalOnly?: boolean;
    initialLength?: number;
    incrementalText?: boolean;
    thinking?: boolean;
  }>([
    { kind: "text" },
    { kind: "incremental text", incrementalText: true },
    { kind: "thinking", thinking: true },
    { kind: "terminal", terminalOnly: true },
    { kind: "shorter final", initialLength: loop.length + 1, terminalOnly: true },
    { kind: "same-length final", initialLength: loop.length, terminalOnly: true },
    { kind: "longer final", initialLength: 16_000, terminalOnly: true },
    { kind: "streamed", initialLength: loop.length, terminalOnly: false },
  ])(
    "quarantines a repetitive $kind block before persistence and replay",
    async ({ terminalOnly, initialLength, incrementalText, thinking }) => {
      const prefix: AssistantMessage["content"] =
        initialLength === undefined ? [{ type: "text", text: "Earlier answer stays intact." }] : [];
      const content: AssistantMessage["content"] = [
        ...prefix,
        thinking ? { type: "thinking", thinking: loop } : { type: "text", text: loop },
      ];
      const response = await runResponse(
        content,
        true,
        terminalOnly,
        initialLength === undefined ? undefined : variedRows.slice(0, initialLength),
        incrementalText,
      );
      const expected: AssistantMessage["content"] = [...prefix, { type: "text", text: marker }];
      expectResponse(response, expected, true);
      if (initialLength !== undefined) {
        return;
      }
      const replay: Message[][] = [];
      await runAgentLoop(
        [user("try a shorter request")],
        { systemPrompt: "", messages: response.result, tools: [] },
        config,
        () => {},
        undefined,
        createTurnSequenceStream([[{ type: "text", text: "Recovered." }]], replay),
      );
      expect(JSON.stringify(replay)).not.toContain("Please provide more input.");
      expect(JSON.stringify(replay)).toContain(marker);
    },
  );

  it("leaves the same response untouched when the policy is off", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: loop }];
    expectResponse(await runResponse(content, false), content);
  });

  it("checks snapshot-only text before persisting and admitting an async tool", async () => {
    const executed: string[] = [];
    const toolCall: AgentToolCall = { ...makeCall("write"), async: true };
    const message = makeAssistantMessage([{ type: "text", text: loop }, toolCall]);
    let requests = 0;
    const result = await runAgentLoop(
      [user()],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("write", executed)],
      },
      { ...config, repetitionGuard: () => true },
      () => {},
      undefined,
      () => {
        if (++requests > 1) {
          return reply(makeAssistantMessage([{ type: "text", text: "Unexpected retry." }]));
        }
        return reply(message, [
          { type: "start", partial: makeAssistantMessage([]) },
          { type: "toolcall_end", contentIndex: 1, toolCall, partial: message },
        ]);
      },
    );
    expect(executed).toEqual([]);
    expect(requests).toBe(1);
    expect(result.at(-1)).toMatchObject({
      stopReason: "error",
      content: [{ type: "text", text: marker }],
    });
    expect(JSON.stringify(result)).not.toContain("Please provide more input.");
  });

  it.each(["delta", "error snapshot"])(
    "settles an admitted tool once without tail admission or retries after a repetitive %s",
    async (source) => {
      const response = createAssistantMessageEventStream();
      const started = createDeferred();
      const finish = createDeferred();
      const observed = { requests: 0, toolAborted: false };
      let requestSignal: AbortSignal | undefined;
      const executed: string[] = [];
      const kept: AgentToolCall = { ...makeCall("kept"), async: true };
      const discarded = makeCall("discarded");
      const streamFn: StreamFn = (_model, _context, options) => {
        if (++observed.requests > 1) {
          return reply(makeAssistantMessage([{ type: "text", text: "Unexpected retry." }]));
        }
        requestSignal = options?.signal;
        requestSignal?.addEventListener("abort", () => finish.resolve(), { once: true });
        return response;
      };
      const run = runAgentLoop(
        [user()],
        {
          systemPrompt: "",
          messages: [],
          tools: [
            {
              ...makeTool("kept"),
              execute: async (_id, _args, signal) => {
                executed.push("kept");
                started.resolve();
                await finish.promise;
                observed.toolAborted = signal?.aborted ?? false;
                return { content: [{ type: "text", text: "Saved." }], details: {} };
              },
            },
            makeTool("discarded", executed),
          ],
        },
        { ...config, repetitionGuard: () => true },
        (event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.content.some((item) => item.type === "text")
          ) {
            finish.resolve();
          }
        },
        undefined,
        streamFn,
      );
      response.push({ type: "start", partial: makeAssistantMessage([]) });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: kept,
        partial: makeAssistantMessage([kept]),
      });
      await started.promise;
      const bad = makeAssistantMessage([kept, { type: "text", text: loop }, discarded]);
      if (source === "delta") {
        response.push({ type: "text_delta", contentIndex: 1, delta: loop, partial: bad });
        response.push({ type: "done", reason: "toolUse", message: bad });
      } else {
        response.push({ type: "error", reason: "error", error: { ...bad, stopReason: "error" } });
      }
      response.end();
      const result = await run;
      expect(observed).toEqual({ requests: 1, toolAborted: false });
      expect(requestSignal?.aborted).toBe(true);
      expect(executed).toEqual(["kept"]);
      expect(result.filter((message) => message.role === "toolResult")).toMatchObject([
        { toolCallId: "kept", content: [{ type: "text", text: "Saved." }] },
      ]);
      expect(result.filter((message) => message.role === "assistant")).toMatchObject([
        { content: [kept], stopReason: "toolUse" },
        { content: [{ type: "text", text: marker }], stopReason: "error" },
      ]);
      expect(JSON.stringify(result)).not.toContain("Please provide more input.");
    },
  );
});
