import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  config,
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "./llm.js";
import { distinctRecordOutputs, variedRows } from "./repetition-guard.test-fixtures.js";
import type { AgentEvent, AgentToolCall, StreamFn } from "./types.js";

const loop = "Please provide more input. ".repeat(800);
const marker = "[Repetitive output stopped]";

async function runResponse(
  content: AssistantMessage["content"],
  enabled = true,
  terminalOnly = false,
  initialText?: string,
  incrementalText = false,
) {
  const events: AgentEvent[] = [];
  let aborted = false;
  let requests = 0;
  const streamFn: StreamFn = (_model, _context, options) => {
    requests += 1;
    options?.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    const response = createAssistantMessageEventStream();
    const message = makeAssistantMessage(content);
    message.providerReplay = {
      v: 1,
      type: "test-checkpoint",
      data: "opaque state containing discarded output",
      api: message.api,
      provider: message.provider,
      model: message.model,
    };
    queueMicrotask(() => {
      if (!terminalOnly || initialText !== undefined) {
        response.push({ type: "start", partial: makeAssistantMessage([]) });
      }
      if (initialText !== undefined) {
        response.push({
          type: "text_delta",
          contentIndex: 0,
          delta: initialText,
          partial: makeAssistantMessage([{ type: "text", text: initialText }]),
        });
      }
      if (!terminalOnly) {
        content.forEach((block, contentIndex) => {
          if (block.type === "text") {
            if (incrementalText) {
              for (let offset = 0; offset < block.text.length; offset += 1024) {
                response.push({
                  type: "text_delta",
                  contentIndex,
                  delta: block.text.slice(offset, offset + 1024),
                });
              }
            } else {
              response.push({
                type: "text_delta",
                contentIndex,
                delta: block.text,
                partial: message,
              });
            }
          } else if (block.type === "thinking") {
            response.push({
              type: "thinking_delta",
              contentIndex,
              delta: block.thinking,
              partial: message,
            });
          }
        });
      }
      response.push({ type: "done", reason: "stop", message });
      response.end();
    });
    return response;
  };
  const loopConfig = { ...config, repetitionGuard: () => enabled };
  const result = await runAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools: [] },
    loopConfig,
    (event) => {
      events.push(event);
    },
    undefined,
    streamFn,
  );
  return { result, events, aborted, requests };
}

describe("repetition stop at the stream owner", () => {
  it.each(distinctRecordOutputs)("delivers $name without truncation", async ({ text }) => {
    const content: AssistantMessage["content"] = [{ type: "text", text }];
    const { result, events, requests } = await runResponse(content);
    expect(requests).toBe(1);
    expect(result.at(-1)).toMatchObject({ stopReason: "stop", content });
    expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
      message: { content },
    });
  });

  it.each(["text", "incremental text", "thinking", "terminal"])(
    "quarantines a repetitive %s block before persistence and replay",
    async (kind) => {
      const content: AssistantMessage["content"] = [
        { type: "text", text: "Earlier answer stays intact." },
        kind === "thinking" ? { type: "thinking", thinking: loop } : { type: "text", text: loop },
      ];
      const { result, events, requests } = await runResponse(
        content,
        true,
        kind === "terminal",
        undefined,
        kind === "incremental text",
      );
      const expected = [content[0], { type: "text", text: marker }];
      expect(result.at(-1)).toMatchObject({
        stopReason: "error",
        errorCode: "openclaw_repetitive_output",
        content: expected,
      });
      expect(result.at(-1)).toHaveProperty("providerReplay", undefined);
      expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
        message: { content: expected },
      });
      expect(requests).toBe(1);
      const replay: Message[][] = [];
      await runAgentLoop(
        [user("try a shorter request")],
        { systemPrompt: "", messages: result, tools: [] },
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
    const { result } = await runResponse(content, false);
    expect(result.at(-1)).toMatchObject({ stopReason: "stop", content });
  });

  it.each([
    { kind: "shorter final", initialLength: loop.length + 1, terminalOnly: true },
    { kind: "same-length final", initialLength: loop.length, terminalOnly: true },
    { kind: "longer final", initialLength: 16_000, terminalOnly: true },
    { kind: "streamed", initialLength: loop.length, terminalOnly: false },
  ])("checks a $kind replacement snapshot", async ({ initialLength, terminalOnly }) => {
    const { result, events, requests } = await runResponse(
      [{ type: "text", text: loop }],
      true,
      terminalOnly,
      variedRows.slice(0, initialLength),
    );
    expect(result.at(-1)).toMatchObject({
      stopReason: "error",
      errorCode: "openclaw_repetitive_output",
      content: [{ type: "text", text: marker }],
    });
    expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
      message: { content: [{ type: "text", text: marker }], providerReplay: undefined },
    });
    expect(requests).toBe(1);
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
        const response = createAssistantMessageEventStream();
        response.push({ type: "start", partial: makeAssistantMessage([]) });
        response.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
        response.push({ type: "done", reason: "toolUse", message });
        response.end();
        return response;
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
      const toolFinished = createDeferred();
      let requestAborted = false;
      let requests = 0;
      let toolAborted = false;
      const executed: string[] = [];
      const kept: AgentToolCall = { ...makeCall("kept"), async: true };
      const discarded = makeCall("discarded");
      const streamFn: StreamFn = (_model, _context, options) => {
        requests++;
        if (requests > 1) {
          return reply(makeAssistantMessage([{ type: "text", text: "Unexpected retry." }]));
        }
        options?.signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            finish.resolve();
          },
          { once: true },
        );
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
                toolAborted = signal?.aborted ?? false;
                toolFinished.resolve();
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
      expect(requests).toBe(1);
      expect(requestAborted).toBe(true);
      expect(toolAborted).toBe(false);
      await toolFinished.promise;
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
