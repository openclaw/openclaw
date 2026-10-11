import type { ChatCompletionContentPart } from "openai/resources/chat/completions.js";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model, UserMessage } from "./types.js";
import { createZeroUsage } from "./usage.test-support.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
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

describe("convertMessages assistant text replay", () => {
  it("serializes advertised video in ordered Chat Completions user content", () => {
    const videoModel = {
      ...model,
      input: ["text", "image", "video"],
    } as ProviderModel<"openai-completions">;
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

    const converted = convertMessages(
      videoModel as Model<"openai-completions">,
      context as Context,
      resolveOpenAICompletionsCompat(videoModel as Model<"openai-completions">),
    );

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
      const assistant: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
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
        ],
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 2,
      };
      const converted = convertMessages(
        model,
        {
          messages: [assistant, makeTextToolResult("call_lookup", "lookup", "found", false, 3)],
        },
        { ...resolveOpenAICompletionsCompat(model), requiresThinkingAsText },
      );

      expect(converted).toEqual([
        {
          role: "assistant",
          content: requiresThinkingAsText
            ? [
                { type: "text", text: "reason\n\nnext😀" },
                { type: "text", text: "first" },
                { type: "text", text: "" },
                { type: "text", text: "last😀" },
              ]
            : "first\n\nlast😀",
          ...(!requiresThinkingAsText && { reasoning_content: "reason\ud800\nnext😀" }),
          tool_calls: [
            {
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"cats"}' },
            },
          ],
          reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic" }],
        },
        { role: "tool", content: "found", tool_call_id: "call_lookup" },
      ]);
    },
  );

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
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

describe("convertMessages parallel tool-result image ownership", () => {
  const imageModel: Model<"openai-completions"> = {
    ...model,
    input: ["text", "image"],
  };

  function makeToolCallAssistant(callIds: string[], toolNames: string[]): AssistantMessage {
    return {
      role: "assistant",
      api: imageModel.api,
      provider: imageModel.provider,
      model: imageModel.id,
      content: callIds.map((id, idx) => ({
        type: "toolCall" as const,
        id,
        name: toolNames[idx] ?? id,
        arguments: {},
      })),
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
  }

  function makeImageToolResult(
    callId: string,
    toolName: string,
    images: Array<{ mimeType: string; data: string }>,
  ) {
    return {
      role: "toolResult" as const,
      toolCallId: callId,
      toolName,
      content: images.map((img) => ({
        type: "image" as const,
        mimeType: img.mimeType,
        data: img.data,
      })),
      isError: false,
      timestamp: 2,
    };
  }

  it.each([""])("counts every reply when labeling sparse images from tool %j", (toolName) => {
    const prefix = "x".repeat(64);
    const callIds: [string, string, string, string] = [
      `${prefix}a`,
      `${prefix}b`,
      `${prefix}c`,
      `${prefix}d`,
    ];
    const context: Context = {
      messages: [
        makeToolCallAssistant(
          callIds,
          callIds.map(() => toolName),
        ),
        {
          role: "toolResult",
          toolCallId: callIds[0],
          toolName,
          content: [{ type: "text", text: "No image from this call" }],
          isError: false,
          timestamp: 2,
        },
        makeImageToolResult(callIds[1], toolName, [{ mimeType: "image/png", data: "AAAA" }]),
        makeImageToolResult(callIds[2], toolName, []),
        makeImageToolResult(callIds[3], toolName, [{ mimeType: "image/png", data: "BBBB" }]),
      ],
    };
    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    expect(
      converted.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ).toEqual(callIds);
    const nameSuffix = toolName ? ` (${toolName})` : "";
    expect(converted.find((message) => message.role === "user")?.content).toEqual([
      { type: "text", text: `Image(s) from tool result #2${nameSuffix}:` },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: `Image(s) from tool result #4${nameSuffix}:` },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ]);
  });
});

describe("convertMessages relocatable region", () => {
  const compat = () => resolveOpenAICompletionsCompat(model);
  const marked = (facts: string) =>
    `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}${facts}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;
  const contextForSession = (sessionId: string): Context => ({
    systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${marked(`## Runtime\nRuntime: session=${sessionId}`)}`,
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  });

  it.each([
    {
      name: "unsupported empty image",
      content: [{ type: "image", mimeType: "image/png", data: "" }],
    },
  ] satisfies Array<{ name: string; content: UserMessage["content"] }>)(
    "keeps Runtime in system content when the only user turn contains $name",
    ({ content }) => {
      const context: Context = {
        systemPrompt: `Stable prefix${marked("Runtime facts")}`,
        messages: [{ role: "user", content, timestamp: 1 }],
      };
      const cacheOptOutIndexes = new Set<number>();

      const converted = convertMessages(model, context, compat(), { cacheOptOutIndexes });

      expect(converted).toEqual([{ role: "system", content: "Stable prefix\nRuntime facts" }]);
      expect(cacheOptOutIndexes.size).toBe(0);
    },
  );

  it.each([
    {
      name: "unsupported image placeholder",
      input: ["text"],
      expectedImage: { type: "text", text: "(image omitted: model does not support images)" },
    },
  ] satisfies Array<{
    name: string;
    input: Model<"openai-completions">["input"];
    expectedImage: ChatCompletionContentPart;
  }>)(
    "preserves the emitted $name and surrounding text on the carrier",
    ({ input, expectedImage }) => {
      const context: Context = {
        systemPrompt: `Stable prefix${marked("Runtime facts")}`,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "image", mimeType: "image/png", data: "aW1n" },
              { type: "text", text: "after" },
            ],
            timestamp: 1,
          },
        ],
      };

      const converted = convertMessages({ ...model, input }, context, compat());

      expect(converted).toEqual([
        { role: "system", content: "Stable prefix" },
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            expectedImage,
            { type: "text", text: "after" },
            { type: "text", text: "Runtime facts" },
          ],
        },
      ]);
    },
  );

  it("uses the first emitted tool-result image carrier and preserves later cache opt-outs", () => {
    const imageModel: Model<"openai-completions"> = { ...model, input: ["text", "image"] };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: imageModel.api,
      provider: imageModel.provider,
      model: imageModel.id,
      content: [
        { type: "toolCall", id: "image_call", name: "read", arguments: { path: "image.png" } },
      ],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    };
    const context: Context = {
      systemPrompt: `Stable prefix${marked("Runtime facts")}`,
      messages: [
        { role: "user", content: [], timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId: "image_call",
          toolName: "read",
          content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: "OpenClaw runtime context:\nlater context",
          timestamp: 4,
          runtimeContext: {},
        },
      ],
    };
    const cacheOptOutIndexes = new Set<number>();

    const converted = convertMessages(imageModel, context, compat(), { cacheOptOutIndexes });

    expect(converted).toEqual([
      { role: "system", content: "Stable prefix" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "image_call",
            type: "function",
            function: { name: "read", arguments: '{"path":"image.png"}' },
          },
        ],
      },
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
    const imageModel: Model<"openai-completions"> = { ...model, input: ["text", "image"] };
    const legacyCarrier: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "legacy plugin runtime context" },
        { type: "image", mimeType: "image/png", data: "aW1n" },
      ],
      timestamp: 1,
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: false,
    };
    const cacheOptOutIndexes = new Set<number>();

    const converted = convertMessages(
      imageModel,
      { systemPrompt: "Stable prefix", messages: [legacyCarrier] },
      compat(),
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

  it("leaves the boundary in place when the caller preserves it", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat(), {
      preserveSystemPromptCacheBoundary: true,
    });

    expect(converted).toEqual([
      {
        role: "system",
        content: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance\n## Runtime\nRuntime: session=alpha`,
      },
      { role: "user", content: "hi" },
    ]);
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
      const turn1: Context = {
        systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}`,
        messages: [{ role: "user", content: "user1", timestamp: 1 }],
      };
      const assistant: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 2,
      };
      const withToolResult: Context = {
        ...turn1,
        messages: [
          ...turn1.messages,
          assistant,
          makeTextToolResult("c1", "read", toolResult, false, 3),
        ],
      };
      const followUp: Context = {
        ...withToolResult,
        messages: [
          ...withToolResult.messages,
          {
            role: "user",
            content: "OpenClaw runtime context:\nnotice",
            runtimeContext: {},
            timestamp: 4,
          },
          { role: "user", content: "user2", timestamp: 5 },
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
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
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
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };

    const converted = convertMessages(model, context, compat());

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
    const context: Context = {
      systemPrompt,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };
    const cacheOptOutIndexes = new Set<number>();

    const converted = convertMessages(model, context, compat(), { cacheOptOutIndexes });

    expect(converted).toEqual([
      { role: "system", content: expectedSystem },
      { role: "user", content: "hi" },
    ]);
    expect(cacheOptOutIndexes.size).toBe(0);
  });
});
