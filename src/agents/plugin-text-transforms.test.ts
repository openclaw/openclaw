// Verifies plugin text transforms rewrite prompts and streamed assistant output.
import { runAgentLoop, type AgentEvent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
  transformPluginMessageText,
  wrapStreamFnTextTransforms,
} from "./plugin-text-transforms.js";

const model = {
  api: "openai-responses",
  provider: "test",
  id: "test-model",
} as Model<"openai-responses">;

function makeAssistantMessage(text: string): AssistantMessage {
  // Output transform tests need a complete assistant message with visible text.
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}

function makeAssistantToolMessage(toolCall: ToolCall): AssistantMessage {
  return {
    ...makeAssistantMessage("unused"),
    content: [toolCall],
    stopReason: "toolUse",
  };
}

describe("plugin text transforms", () => {
  it("merges registered transform groups in order", () => {
    const merged = mergePluginTextTransforms(
      { input: [{ from: /red basket/g, to: "blue basket" }] },
      { output: [{ from: /blue basket/g, to: "red basket" }] },
      { input: [{ from: /paper ticket/g, to: "digital ticket" }] },
    );

    expect(merged).toStrictEqual({
      input: [
        { from: /red basket/g, to: "blue basket" },
        { from: /paper ticket/g, to: "digital ticket" },
      ],
      output: [{ from: /blue basket/g, to: "red basket" }],
    });
    expect(applyPluginTextReplacements("red basket paper ticket", merged?.input)).toBe(
      "blue basket digital ticket",
    );
  });

  it("applies ordered string and regexp replacements", () => {
    expect(
      applyPluginTextReplacements("paper ticket on the left shelf", [
        { from: /paper ticket/g, to: "digital ticket" },
        { from: /left shelf/g, to: "right shelf" },
        { from: "digital ticket", to: "counter receipt" },
      ]),
    ).toBe("counter receipt on the right shelf");
  });

  it("rewrites system prompt and message text content before transport", async () => {
    let capturedContext: Context | undefined;
    const wrapped = wrapStreamFnTextTransforms({
      streamFn: (_model, context) => {
        capturedContext = context;
        const stream = createAssistantMessageEventStream();
        stream.end();
        return stream;
      },
      input: [
        {
          from: /orchid mailbox/g,
          to: "pine mailbox",
        },
        { from: /red basket/g, to: "blue basket" },
      ],
    });
    await Promise.resolve(
      wrapped(
        model,
        {
          systemPrompt: "Use orchid mailbox inside north tower",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Please use the red basket" },
                { type: "image", url: "data:image/png;base64,abc" },
              ],
            },
          ],
        } as Context,
        undefined,
      ),
    );

    const context = capturedContext as unknown as {
      systemPrompt: string;
      messages: Array<{ content: unknown[] }>;
    };

    expect(context.systemPrompt).toBe("Use pine mailbox inside north tower");
    const textContent = context.messages[0]?.content[0] as
      | { type?: string; text?: string }
      | undefined;
    expect(textContent?.type).toBe("text");
    expect(textContent?.text).toBe("Please use the blue basket");
    const imageContent = context.messages[0]?.content[1] as
      | { type?: string; url?: string }
      | undefined;
    expect(imageContent?.type).toBe("image");
    expect(imageContent?.url).toBe("data:image/png;base64,abc");
  });

  it("wraps stream functions with inbound and outbound replacements", async () => {
    // The wrapper mutates text-only blocks while preserving non-text content.
    let capturedContext: Context | undefined;
    const baseStreamFn: StreamFn = (_model, context) => {
      capturedContext = context;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = makeAssistantMessage("blue basket on the right shelf");
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "blue basket on the right shelf",
          partial,
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAssistantMessage("final blue basket on the right shelf"),
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnTextTransforms({
      streamFn: baseStreamFn,
      input: [{ from: /red basket/g, to: "blue basket" }],
      output: [
        { from: /blue basket/g, to: "red basket" },
        { from: /right shelf/g, to: "left shelf" },
      ],
      transformSystemPrompt: false,
    });
    const stream = await Promise.resolve(
      wrapped(
        model,
        {
          systemPrompt: "Keep red basket untouched here",
          messages: [{ role: "user", content: "Use red basket" }],
        } as Context,
        undefined,
      ),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    expect(capturedContext?.systemPrompt).toBe("Keep red basket untouched here");
    expect(capturedContext?.messages).toEqual([{ role: "user", content: "Use blue basket" }]);
    const firstEvent = events[0] as { type?: string; delta?: string } | undefined;
    expect(firstEvent?.type).toBe("text_delta");
    expect(firstEvent?.delta).toBe("red basket on the left shelf");
    expect(result.content).toEqual([{ type: "text", text: "final red basket on the left shelf" }]);
  });

  it("wraps streamed tool call deltas and argument strings with outbound replacements", async () => {
    const streamedToolCall: ToolCall = {
      type: "toolCall",
      id: "call_[MASKED]",
      name: "send_[MASKED]",
      arguments: {
        text: "Message for [MASKED]",
        nested: { title: "[MASKED] follow-up", count: 2 },
        recipients: ["[MASKED]", "ops", true],
      },
      partialArgs: '{"text":"Message for [MASKED]"}',
      partialJson: '{"text":"Message for [MASKED]"}',
    } as ToolCall;
    const finalToolCall: ToolCall = {
      ...streamedToolCall,
      arguments: {
        text: "Final message for [MASKED]",
        nested: { title: "[MASKED] final", enabled: false },
      },
      partialArgs: '{"text":"Final message for [MASKED]"}',
      partialJson: '{"text":"Final message for [MASKED]"}',
    } as ToolCall;
    const partial = makeAssistantToolMessage(streamedToolCall);
    const finalMessage = makeAssistantToolMessage(finalToolCall);
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"text":"Message for [MASKED]"}',
          partial,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: streamedToolCall,
          partial,
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: finalMessage,
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnTextTransforms({
      streamFn: baseStreamFn,
      output: [{ from: /\[MASKED\]/g, to: "John Smith" }],
    });
    const stream = await Promise.resolve(wrapped(model, { messages: [] } as Context, undefined));
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    const delta = events[0] as { type?: string; delta?: string; partial?: AssistantMessage };
    expect(delta.type).toBe("toolcall_delta");
    expect(delta.delta).toBe('{"text":"Message for John Smith"}');
    expect(delta.partial?.content[0]).toMatchObject({
      id: "call_[MASKED]",
      name: "send_[MASKED]",
      partialArgs: '{"text":"Message for John Smith"}',
      partialJson: '{"text":"Message for John Smith"}',
      arguments: {
        text: "Message for John Smith",
        nested: { title: "John Smith follow-up", count: 2 },
        recipients: ["John Smith", "ops", true],
      },
    });

    const end = events[1] as { type?: string; toolCall?: ToolCall; partial?: AssistantMessage };
    expect(end.type).toBe("toolcall_end");
    expect(end.toolCall).toMatchObject({
      id: "call_[MASKED]",
      name: "send_[MASKED]",
      partialArgs: '{"text":"Message for John Smith"}',
      partialJson: '{"text":"Message for John Smith"}',
      arguments: {
        text: "Message for John Smith",
        nested: { title: "John Smith follow-up", count: 2 },
        recipients: ["John Smith", "ops", true],
      },
    });
    expect(result.content[0]).toMatchObject({
      id: "call_[MASKED]",
      name: "send_[MASKED]",
      partialArgs: '{"text":"Final message for John Smith"}',
      partialJson: '{"text":"Final message for John Smith"}',
      arguments: {
        text: "Final message for John Smith",
        nested: { title: "John Smith final", enabled: false },
      },
    });
  });

  it("rewrites finalized tool call arguments before agent tool execution", async () => {
    const output = [{ from: /cat/g, to: "black cat" }];
    const capturedEvents: AgentEvent[] = [];
    const executedArgs: unknown[] = [];
    let turn = 0;
    const baseStreamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantToolMessage({
                type: "toolCall",
                id: "call_read",
                name: "read",
                arguments: { path: "cat.txt" },
                partialArgs: '{"path":"cat.txt"}',
              } as ToolCall)
            : makeAssistantMessage("done");
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const wrapped = wrapStreamFnTextTransforms({
      streamFn: baseStreamFn,
      output,
      transformFinalResult: false,
    });

    await runAgentLoop(
      [{ role: "user", content: "read it", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "read",
            label: "read",
            description: "read",
            parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
            execute: async (_toolCallId, args) => {
              executedArgs.push(args);
              return {
                content: [{ type: "text", text: "ok" }],
                details: args,
                terminate: true,
              };
            },
          },
        ],
      },
      {
        model,
        convertToLlm: (messages) => messages as never,
        transformAssistantMessage: (message) => transformPluginMessageText(message, output),
      },
      (event) => {
        capturedEvents.push(event);
      },
      undefined,
      wrapped,
    );

    const toolStart = capturedEvents.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
        event.type === "tool_execution_start",
    );
    expect(toolStart?.args).toEqual({ path: "black cat.txt" });
    expect(executedArgs).toEqual([{ path: "black cat.txt" }]);
  });
});
