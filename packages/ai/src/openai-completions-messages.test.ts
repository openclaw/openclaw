import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model, UserMessage } from "./types.js";
import { createZeroUsage } from "./usage.test-support.js";
import {
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "./utils/system-prompt-cache-boundary.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = createZeroUsage();
const imageModel: Model<"openai-completions"> = { ...model, input: ["text", "image"] };
const image = (data = "aW1n") => ({ type: "image" as const, mimeType: "image/png", data });
const tools = (name: string) => [{ name, description: name, parameters: { type: "object" } }];
function user(content: UserMessage["content"], overrides: Partial<UserMessage> = {}): UserMessage {
  return { role: "user", content, timestamp: 1, ...overrides };
}
const runtimeNotice = (text: string, timestamp: number) =>
  user(`OpenClaw runtime context:\n${text}`, { runtimeContext: {}, timestamp });
function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 2,
    content,
    ...overrides,
  };
}
function imageResult(callId: string, toolName: string, data: string[], timestamp = 2) {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName,
    content: data.map(image),
    isError: false,
    timestamp,
  };
}
function expectedToolCall(id: string, name: string, args: string) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}
function convert(
  context: ProviderContext,
  target: ProviderModel<"openai-completions"> = model,
  options?: Parameters<typeof convertMessages>[3],
) {
  return convertMessages(target, context, resolveOpenAICompletionsCompat(target), options);
}
const marked = (facts: string) =>
  `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}${facts}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;
function runtimeContext(messages: Context["messages"], overrides: Partial<Context> = {}): Context {
  return { messages, systemPrompt: `Stable prefix${marked("Runtime facts")}`, ...overrides };
}

describe("convertMessages assistant text replay", () => {
  it("serializes advertised video in ordered Chat Completions user content", () => {
    const videoModel: ProviderModel<"openai-completions"> = {
      ...model,
      input: ["text", "image", "video"],
    };
    const context: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: "image" },
            { type: "video", mimeType: "video/mp4", data: "video" },
            { type: "text", text: "after" },
          ],
          timestamp: 1,
        },
      ],
    };

    const converted = convert(context, videoModel);

    expect(converted[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,image" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,video" } },
      { type: "text", text: "after" },
    ]);
  });

  it.each([false, true])(
    "preserves interleaved text, thinking, and tool replay with thinking-as-text %s",
    (requiresThinkingAsText) => {
      const replay = assistant([
        { type: "thinking", thinking: " \t", thinkingSignature: "reasoning_text" },
        {
          type: "thinking",
          thinking: "reason\ud800",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: " \t" },
        { type: "text", text: "first\ud800" },
        { type: "text", text: "\udc00" },
        {
          type: "toolCall",
          id: "call_lookup",
          name: "lookup",
          arguments: { query: "cats" },
          thoughtSignature: '{"type":"reasoning.encrypted","data":"synthetic"}',
        },
        { type: "thinking", thinking: "next😀", thinkingSignature: "reasoning_text" },
        { type: "text", text: "last😀" },
      ]);
      const converted = convertMessages(
        model,
        {
          tools: tools("lookup"),
          messages: [replay, makeTextToolResult("call_lookup", "lookup", "found", false, 3)],
        },
        { ...resolveOpenAICompletionsCompat(model), requiresThinkingAsText },
      );

      expect(converted).toEqual([
        {
          ...expectedToolCall("call_lookup", "lookup", '{"query":"cats"}'),
          content: requiresThinkingAsText
            ? [
                { type: "text", text: "reason\n\nnext😀" },
                { type: "text", text: "first" },
                { type: "text", text: "" },
                { type: "text", text: "last😀" },
              ]
            : "first\n\nlast😀",
          ...(!requiresThinkingAsText && { reasoning_content: "reason\ud800\nnext😀" }),
          reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic" }],
        },
        { role: "tool", content: "found", tool_call_id: "call_lookup" },
      ]);
    },
  );

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel = { ...model, id: "target-model", provider: "openai" };
    const context: Context = {
      tools: tools("lookup"),
      messages: [
        assistant([{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }], {
          api: targetModel.api,
          provider: targetModel.provider,
          model: "source-model",
          timestamp: 1,
        }),
        makeTextToolResult(oversizedId, "lookup", "ok", false, 2),
      ],
    };

    const converted = convert(context, targetModel);
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});

it("counts every reply when labeling sparse images from an unnamed tool", () => {
  const toolName = "";
  const prefix = "x".repeat(64);
  const callIds: [string, string, string, string] = [
    `${prefix}a`,
    `${prefix}b`,
    `${prefix}c`,
    `${prefix}d`,
  ];
  const context: Context = {
    tools: tools(toolName),
    messages: [
      assistant(
        callIds.map((id) => ({ type: "toolCall", id, name: toolName, arguments: {} })),
        {
          timestamp: 1,
        },
      ),
      makeTextToolResult(callIds[0], toolName, "No image from this call", false, 2),
      imageResult(callIds[1], toolName, ["AAAA"]),
      imageResult(callIds[2], toolName, []),
      imageResult(callIds[3], toolName, ["BBBB"]),
    ],
  };
  const converted = convert(context, imageModel);

  expect(
    converted.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
  ).toEqual(callIds);
  expect(converted.find((message) => message.role === "user")?.content).toEqual([
    { type: "text", text: "Image(s) from tool result #2:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: "Image(s) from tool result #4:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
  ]);
});

describe("convertMessages relocatable region", () => {
  const compat = () => resolveOpenAICompletionsCompat(model);

  it("keeps Runtime in system content when the only user turn contains an unsupported empty image", () => {
    const context = runtimeContext([user([image("")])]);
    const cacheOptOutIndexes = new Set<number>();

    const converted = convert(context, model, { cacheOptOutIndexes });

    expect(converted).toEqual([{ role: "system", content: "Stable prefix\nRuntime facts" }]);
    expect(cacheOptOutIndexes.size).toBe(0);
  });

  it("preserves the emitted unsupported image placeholder and surrounding text on the carrier", () => {
    const context = runtimeContext([
      user([{ type: "text", text: "before" }, image(), { type: "text", text: "after" }]),
    ]);
    const converted = convert(context);

    expect(converted).toEqual([
      { role: "system", content: "Stable prefix" },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "text", text: "(image omitted: model does not support images)" },
          { type: "text", text: "after" },
          { type: "text", text: "Runtime facts" },
        ],
      },
    ]);
  });

  it("uses the first emitted tool-result image carrier and preserves later cache opt-outs", () => {
    const context = runtimeContext(
      [
        user([]),
        assistant([
          { type: "toolCall", id: "image_call", name: "read", arguments: { path: "image.png" } },
        ]),
        imageResult("image_call", "read", ["aW1n"], 3),
        runtimeNotice("later context", 4),
      ],
      { tools: tools("read") },
    );
    const cacheOptOutIndexes = new Set<number>();

    const converted = convert(context, imageModel, { cacheOptOutIndexes });

    expect(converted).toEqual([
      { role: "system", content: "Stable prefix" },
      expectedToolCall("image_call", "read", '{"path":"image.png"}'),
      { role: "tool", tool_call_id: "image_call", content: "(see attached image)" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image(s) from tool result #1 (read):" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
          { type: "text", text: "Runtime facts" },
        ],
      },
      { role: "developer", content: "OpenClaw runtime context:\nlater context" },
    ]);
    expect(cacheOptOutIndexes).toEqual(new Set([3, 4]));
  });

  it("keeps mixed-media shipped carriers out of the prompt cache", () => {
    const legacyCarrier = user([{ type: "text", text: "legacy plugin runtime context" }, image()], {
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: false,
    });
    const cacheOptOutIndexes = new Set<number>();

    const converted = convert(
      { systemPrompt: "Stable prefix", messages: [legacyCarrier] },
      imageModel,
      { cacheOptOutIndexes },
    );

    expect(converted).toEqual([
      { role: "system", content: "Stable prefix" },
      {
        role: "user",
        content: [
          { type: "text", text: "legacy plugin runtime context" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
        ],
      },
    ]);
    expect(cacheOptOutIndexes).toEqual(new Set([1]));
  });

  it.each([
    { reasoning: true, supportsDeveloperRole: false, noticeRole: "user" },
    { reasoning: true, supportsDeveloperRole: true, noticeRole: "developer" },
  ])(
    "preserves prior prompt bytes when runtime notices follow tool results (%j)",
    ({ reasoning, supportsDeveloperRole, noticeRole }) => {
      const noticeModel = { ...model, reasoning };
      const noticeCompat = { ...compat(), supportsDeveloperRole };
      // Moving Runtime to the last user turn used to rewrite the earlier cached prefix.
      const toolResult = "X".repeat(30000);
      const turn1 = runtimeContext([user("user1")], {
        tools: tools("read"),
        systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}`,
      });
      const withToolResult: Context = {
        ...turn1,
        messages: [
          ...turn1.messages,
          assistant([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
          makeTextToolResult("c1", "read", toolResult, false, 3),
        ],
      };
      const followUp: Context = {
        ...withToolResult,
        messages: [
          ...withToolResult.messages,
          runtimeNotice("notice", 4),
          user("user2", { timestamp: 5 }),
        ],
      };

      const original = structuredClone(followUp);
      const cacheOptOutIndexes = new Set<number>();
      const first = convertMessages(noticeModel, turn1, noticeCompat);
      const beforeFollowUp = convertMessages(noticeModel, withToolResult, noticeCompat);
      const afterFollowUp = convertMessages(noticeModel, followUp, noticeCompat, {
        cacheOptOutIndexes,
      });

      expect(beforeFollowUp).toEqual([
        ...first,
        expectedToolCall("c1", "read", "{}"),
        { role: "tool", tool_call_id: "c1", content: toolResult },
      ]);
      expect(JSON.stringify(afterFollowUp.slice(0, beforeFollowUp.length))).toBe(
        JSON.stringify(beforeFollowUp),
      );
      expect(afterFollowUp.slice(-2)).toEqual([
        { role: noticeRole, content: "OpenClaw runtime context:\nnotice" },
        { role: "user", content: "user2" },
      ]);
      expect(cacheOptOutIndexes).toEqual(new Set([1, 4]));
      expect(followUp).toEqual(original);
    },
  );

  it("keeps trailing permission guidance in the system message", () => {
    const notice = [
      "<!-- openclaw:attempt:PERMISSION -->",
      "Permissions changed. Inspect interrupted actions; do not repeat completed ones.",
      "<!-- /openclaw:attempt:PERMISSION -->",
    ].join("\n");
    const context: Context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}\n${notice}`,
      messages: [user("hi")],
    };

    const converted = convert(context);

    expect(converted[0]?.content).toContain("Inspect interrupted actions");
    expect(converted[1]?.content).not.toContain("Inspect interrupted actions");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it.each([
    {
      name: "missing opening marker",
      systemPrompt: `Stable prefix\nRuntime facts${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\nRetry guidance`,
      expectedSystem: "Stable prefix\nRuntime facts\nRetry guidance",
    },
    {
      name: "reversed markers",
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\nRetry guidance${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime facts`,
      expectedSystem: "Stable prefix\nRetry guidance\nRuntime facts",
    },
    {
      name: "two complete regions",
      systemPrompt: `Stable prefix${marked("Retry guidance")}${marked("Runtime facts")}`,
      expectedSystem: "Stable prefix\nRetry guidance\nRuntime facts",
    },
    {
      name: "duplicate closing after the complete region",
      systemPrompt: `Stable prefix${marked("Runtime facts")}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\nRetry guidance`,
      expectedSystem: "Stable prefix\nRuntime facts\nRetry guidance",
    },
  ])("retains all text at system authority for $name", ({ systemPrompt, expectedSystem }) => {
    const context = runtimeContext([user("hi")], { systemPrompt });
    const cacheOptOutIndexes = new Set<number>();

    const converted = convert(context, model, { cacheOptOutIndexes });

    expect(converted).toEqual([
      { role: "system", content: expectedSystem },
      { role: "user", content: "hi" },
    ]);
    expect(cacheOptOutIndexes.size).toBe(0);
  });
});
