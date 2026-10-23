import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function toolCallMessage(
  name: string,
  argumentsValue: Record<string, unknown> = { query: "OpenClaw" },
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "opencode",
    model: "gpt-5.6-sol",
    content: [{ type: "toolCall", id: "call_1", name, arguments: structuredClone(argumentsValue) }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

async function wrapOpenCodeStream(streamFn: StreamFn, modelId = "gpt-5.6-sol") {
  const provider = await registerSingleProviderPlugin(plugin);
  const wrapped = provider.wrapStreamFn?.({ streamFn, providerId: "opencode", modelId } as never);
  if (!wrapped) {
    throw new Error("expected OpenCode stream wrapper");
  }
  return wrapped;
}

function runStream(
  streamFn: StreamFn,
  options: Parameters<StreamFn>[2] = {},
  id = "gpt-5.6-sol",
  api = "openai-responses",
) {
  return streamFn({ provider: "opencode", id, api } as never, { messages: [] } as never, options);
}

function endToolCall(message: AssistantMessage): AssistantMessageEvent {
  return {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: message.content[0] as never,
    partial: message,
  };
}

const messageContent = (block: Record<string, unknown>) => ({ content: [block] });
const callContent = (name: string, argumentsValue?: Record<string, unknown>) =>
  messageContent({ name, ...(argumentsValue ? { arguments: argumentsValue } : {}) });
const envArguments = { command: "node app.js", env: [{ key: "NODE_ENV", value: "test" }] };
const restoredEnv = { command: "node app.js", env: { NODE_ENV: "test" } };
const jsonArguments = { label: "42", seed: 42, enabled: true, empty: null };
const wireJson = [
  { key: "label", value: '"42"' },
  { key: "seed", value: "42" },
  { key: "enabled", value: "true" },
  { key: "empty", value: "null" },
];
const duplicateKeys = [
  { key: "title", value: '"first"' },
  { key: "title", value: '"second"' },
];
const invalidJson = [{ key: "broken", value: "not-json" }];

async function capturePayload(model: Parameters<StreamFn>[0], options: Parameters<StreamFn>[2]) {
  const initial = { model: model.id };
  return ((await options?.onPayload?.(initial, model)) ?? initial) as Record<string, unknown>;
}

function recordTool(name: string, field: string, valueSchema: Record<string, unknown> = {}) {
  return {
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: { [field]: { type: "object", patternProperties: { "^.*$": valueSchema } } },
    },
  };
}

describe("OpenCode stream adapter", () => {
  it("aliases the reserved web_search function across OpenCode Responses requests", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const existingAlias = "openclaw_web_search";
    const wireAlias = "openclaw_web_search_2";
    const wireArguments = { options: [{ key: "region", value: "us" }] };
    const restoredArguments = { options: { region: "us" } };
    const producerContent = callContent(wireAlias, wireArguments);
    const restoredContent = callContent("web_search", restoredArguments);
    let producerPartial: AssistantMessage | undefined;
    let producerTerminal: AssistantMessage | undefined;
    let releaseTerminal = () => {};
    const allowTerminal = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      capturedPayload = await capturePayload(model, options);
      const stream = createAssistantMessageEventStream();
      producerPartial = toolCallMessage(wireAlias, wireArguments);
      producerTerminal = toolCallMessage(wireAlias, wireArguments);
      queueMicrotask(() => {
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: producerPartial as AssistantMessage,
        });
        void allowTerminal.then(() => {
          stream.push(endToolCall(producerPartial as AssistantMessage));
          stream.push({
            type: "done",
            reason: "toolUse",
            message: producerTerminal as AssistantMessage,
          });
        });
      });
      return stream;
    };
    const streamFn = await wrapOpenCodeStream(baseStreamFn);

    const stream = await runStream(streamFn, {
      onPayload: () => ({
        tools: [
          recordTool("web_search", "options", { type: "string" }),
          { type: "function", name: existingAlias },
          { type: "function", name: "read" },
        ],
        input: [{ type: "function_call", name: "web_search", call_id: "call_0" }],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "web_search" },
            { type: "function", name: existingAlias },
          ],
        },
      }),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      throw new Error("expected staged tool-call event");
    }
    const events = [first.value];
    expect(first.value).toMatchObject({
      type: "toolcall_start",
      partial: restoredContent,
    });
    expect([producerPartial, producerTerminal]).toMatchObject([producerContent, producerContent]);
    releaseTerminal();
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      events.push(next.value);
    }

    expect(capturedPayload).toMatchObject({
      tools: [
        { type: "function", name: wireAlias },
        { type: "function", name: existingAlias },
        { type: "function", name: "read" },
      ],
      input: [{ type: "function_call", name: wireAlias, call_id: "call_0" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", name: wireAlias },
          { type: "function", name: existingAlias },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      type: "toolcall_end",
      toolCall: { name: "web_search", arguments: { options: { region: "us" } } },
      partial: restoredContent,
    });
    expect(events[2]).toMatchObject({
      type: "done",
      message: messageContent({ name: "web_search" }),
    });
    await expect(stream.result()).resolves.toMatchObject(restoredContent);
    expect([producerPartial, producerTerminal]).toMatchObject([producerContent, producerContent]);
  });

  it("does not restore an unaliased OpenCode Responses function name", async () => {
    const existingAlias = "openclaw_web_search";
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: existingAlias }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage(existingAlias)));
      return source;
    };
    const streamFn = await wrapOpenCodeStream(baseStreamFn);

    const stream = await runStream(streamFn, {});

    expect(payload.tools[0]?.name).toBe(existingAlias);
    await expect(stream?.result()).resolves.toMatchObject(messageContent({ name: existingAlias }));
  });

  it("round-trips dynamic record tool arguments through OpenCode-compatible schemas", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    let producerDelta: Extract<AssistantMessageEvent, { type: "toolcall_delta" }> | undefined;
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      capturedPayload = await capturePayload(model, options);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const execMessage = toolCallMessage("exec", envArguments);
        const streamingCall = {
          ...execMessage.content[0]!,
          partialJson: JSON.stringify(envArguments),
        };
        producerDelta = {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(envArguments),
          partial: { ...execMessage, content: [streamingCall] },
        };
        stream.push(producerDelta);
        stream.push(endToolCall(execMessage));
        stream.push(endToolCall(toolCallMessage("dashboard", { props: duplicateKeys })));
        stream.push(
          endToolCall(toolCallMessage("video_generate", { providerOptions: invalidJson })),
        );
        stream.push({
          type: "done",
          reason: "toolUse",
          message: toolCallMessage("video_generate", { providerOptions: wireJson }),
        });
      });
      return stream;
    };
    const streamFn = await wrapOpenCodeStream(baseStreamFn);

    const stream = await runStream(streamFn, {
      onPayload: () => ({
        tools: [
          recordTool("exec", "env", { type: "string" }),
          recordTool("video_generate", "providerOptions"),
          recordTool("dashboard", "props"),
        ],
        input: [
          {
            type: "function_call",
            name: "exec",
            arguments: JSON.stringify(restoredEnv),
          },
          {
            type: "function_call",
            name: "video_generate",
            arguments: { providerOptions: structuredClone(jsonArguments) },
          },
        ],
      }),
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const tools = capturedPayload?.tools as Array<Record<string, unknown>>;
    const execParameters = tools[0]?.parameters as Record<string, unknown>;
    const execProperties = execParameters.properties as Record<string, unknown>;
    expect(execProperties.env).toMatchObject({
      type: "array",
      items: {
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(execProperties.env)).not.toContain("patternProperties");
    const input = capturedPayload?.input as Array<Record<string, unknown>>;
    expect(JSON.parse(input[0]?.arguments as string)).toEqual(envArguments);
    expect(input[1]?.arguments).toEqual({ providerOptions: wireJson });
    expect(events[0]).toMatchObject({
      type: "toolcall_delta",
      delta: "",
      partial: messageContent({ arguments: restoredEnv }),
    });
    if (events[0]?.type === "toolcall_delta") {
      expect(events[0].partial.content[0]).not.toHaveProperty("partialJson");
    }
    expect(producerDelta).toMatchObject({
      delta: '{"command":"node app.js","env":[{"key":"NODE_ENV","value":"test"}]}',
      partial: messageContent({
        arguments: envArguments,
      }),
    });
    expect(events[1]).toMatchObject({
      type: "toolcall_end",
      toolCall: { arguments: restoredEnv },
    });
    expect(events[2]).toMatchObject({
      type: "toolcall_end",
      toolCall: { arguments: { props: duplicateKeys } },
    });
    expect(events[3]).toMatchObject({
      type: "toolcall_end",
      toolCall: { arguments: { providerOptions: invalidJson } },
    });
    expect(events[4]).toMatchObject({
      type: "done",
      message: messageContent({ arguments: { providerOptions: jsonArguments } }),
    });
    await expect(stream.result()).resolves.toMatchObject(
      messageContent({ arguments: { providerOptions: jsonArguments } }),
    );
  });

  it("rebuilds dynamic record metadata when a Responses request payload is rebuilt", async () => {
    const firstPayload = {
      tools: [recordTool("exec", "env", { type: "string" })],
    };
    const secondPayload = {
      tools: [
        {
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: { env: { type: "array", items: { type: "string" } } },
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      await options?.onPayload?.(firstPayload, model);
      await options?.onPayload?.(secondPayload, model);
      const source = createAssistantMessageEventStream();
      queueMicrotask(() =>
        source.end(
          toolCallMessage("exec", {
            env: [{ key: "literal", value: "array" }],
          }),
        ),
      );
      return source;
    };
    const streamFn = await wrapOpenCodeStream(baseStreamFn);

    const stream = await runStream(streamFn, {});

    expect(firstPayload.tools[0]?.parameters.properties).toMatchObject({ env: { type: "array" } });
    expect(secondPayload.tools[0]?.parameters.properties.env).toEqual({
      type: "array",
      items: { type: "string" },
    });
    await expect(stream?.result()).resolves.toMatchObject(
      messageContent({
        arguments: { env: [{ key: "literal", value: "array" }] },
      }),
    );
  });

  it("leaves web_search unchanged for non-Responses OpenCode models", async () => {
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: "web_search" }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage("web_search")));
      return source;
    };
    const streamFn = await wrapOpenCodeStream(baseStreamFn, "kimi-k2.6");

    const stream = await runStream(streamFn, {}, "kimi-k2.6", "openai-completions");
    expect(stream).toBe(source);
    expect(payload.tools[0]?.name).toBe("web_search");
  });
});
