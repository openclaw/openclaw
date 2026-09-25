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

  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
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

  it("distinguishes image ownership between different parallel result partitions", () => {
    const imgA = { mimeType: "image/png", data: "AAAA" };
    const imgB = { mimeType: "image/png", data: "BBBB" };
    const imgC = { mimeType: "image/png", data: "CCCC" };

    // Partition P: call_a=[A], call_b=[B,C]
    const contextP: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA]),
        makeImageToolResult("call_b", "camera", [imgB, imgC]),
      ],
    };

    // Partition Q: call_a=[A,B], call_b=[C]
    const contextQ: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA, imgB]),
        makeImageToolResult("call_b", "camera", [imgC]),
      ],
    };

    const convertedP = convertMessages(
      imageModel,
      contextP,
      resolveOpenAICompletionsCompat(imageModel),
    );
    const convertedQ = convertMessages(
      imageModel,
      contextQ,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgP = convertedP.find((m) => m.role === "user" && Array.isArray(m.content));
    const userMsgQ = convertedQ.find((m) => m.role === "user" && Array.isArray(m.content));

    // The two partitions must produce different content (ownership is distinguishable)
    expect(JSON.stringify(userMsgP?.content)).not.toBe(JSON.stringify(userMsgQ?.content));

    // Partition P: first group has 1 image from screenshot, second has 2 from camera
    const contentP = userMsgP?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentP).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "Image(s) from tool result #2 (camera):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);

    // Partition Q: first group has 2 images from screenshot, second has 1 from camera
    const contentQ = userMsgQ?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentQ).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "text", text: "Image(s) from tool result #2 (camera):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);
  });

  it("labels single tool-result images with result position and tool name", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_x"], ["screenshot"]),
        makeImageToolResult("call_x", "screenshot", [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it.each(["screenshot", ""])(
    "counts every reply when labeling sparse images from tool %j",
    (toolName) => {
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
        converted
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      ).toEqual(callIds);
      const nameSuffix = toolName ? ` (${toolName})` : "";
      expect(converted.find((message) => message.role === "user")?.content).toEqual([
        { type: "text", text: `Image(s) from tool result #2${nameSuffix}:` },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: `Image(s) from tool result #4${nameSuffix}:` },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ]);
    },
  );

  it("does not emit a user message when tool results have no images", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["lookup", "search"]),
        makeTextToolResult("call_a", "lookup", "found it", false, 2),
        makeTextToolResult("call_b", "search", "no results", false, 3),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgs = converted.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(0);
  });

  it("handles mixed text and image tool results", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a"], ["screenshot"]),
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "screenshot",
          content: [
            { type: "text", text: "Captured screen region" },
            { type: "image", mimeType: "image/png", data: "aW1n" },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    // Tool message gets the text content
    const toolMsg = converted.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      role: "tool",
      content: "Captured screen region",
      tool_call_id: "call_a",
    });

    // User message gets the labeled image
    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it("bounds tool names without changing full call identifiers", () => {
    const namePrefix = "x".repeat(63);
    const longName = `${namePrefix}🙂tail`;
    const longCallId = `${"y".repeat(200)}🙂`;
    const context: Context = {
      messages: [
        makeToolCallAssistant([longCallId], [longName]),
        makeImageToolResult(longCallId, longName, [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    const content = userMsg?.content as Array<{ type: string; text?: string }>;
    const labelText = content[0]?.text ?? "";

    expect(labelText).toBe(`Image(s) from tool result #1 (${namePrefix}):`);
    expect(labelText).not.toMatch(/[\uD800-\uDFFF]/u);
    const toolMessage = converted.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.tool_call_id).toBe(longCallId);
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
    { reasoning: false, role: "system" },
    { reasoning: true, role: "developer" },
  ])(
    "keeps behavioral guidance at $role authority while relocating facts",
    ({ reasoning, role }) => {
      const cacheOptOutIndexes = new Set<number>();
      const converted = convertMessages(
        { ...model, reasoning },
        contextForSession("alpha"),
        { ...compat(), supportsDeveloperRole: true },
        { cacheOptOutIndexes },
      );

      expect(converted).toEqual([
        { role, content: "Stable prefix\nReactions guidance" },
        { role: "user", content: "hi\n\n## Runtime\nRuntime: session=alpha" },
      ]);
      expect(cacheOptOutIndexes).toEqual(new Set([1]));
    },
  );

  it("does not relocate when only the cache boundary is present", () => {
    const context: Context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\nReactions guidance");
    expect(converted[1]?.content).toBe("hi");
  });

  it("keeps the system message byte-identical across sessions", () => {
    const first = convertMessages(model, contextForSession("alpha"), compat());
    const second = convertMessages(model, contextForSession("beta"), compat());

    expect(JSON.stringify(first[0])).toBe(JSON.stringify(second[0]));
    expect(first[1]?.content).not.toEqual(second[1]?.content);
  });

  it.each([
    { name: "empty content", content: [] },
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
      name: "supported image",
      input: ["text", "image"],
      expectedImage: { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    },
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

  it("uses the later emitted user turn when an unsupported empty image projects away", () => {
    const context: Context = {
      systemPrompt: `Stable prefix${marked("Runtime facts")}`,
      messages: [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "" }],
          timestamp: 1,
        },
        { role: "user", content: "surviving turn", timestamp: 2 },
      ],
    };
    const cacheOptOutIndexes = new Set<number>();

    const converted = convertMessages(model, context, compat(), { cacheOptOutIndexes });

    expect(converted).toEqual([
      { role: "system", content: "Stable prefix" },
      { role: "user", content: "surviving turn\n\nRuntime facts" },
    ]);
    expect(cacheOptOutIndexes).toEqual(new Set([1]));
  });

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
        { role: "user", content: "later context", runtimeContextCarrier: true, timestamp: 4 },
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
      { role: "user", content: "later context" },
    ]);
    expect(cacheOptOutIndexes).toEqual(new Set([3, 4]));
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

  it("leaves a trailing structural marker in the system prompt", () => {
    const context: Context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}<!-- /openclaw:attempt:DYNAMIC -->`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\n<!-- /openclaw:attempt:DYNAMIC -->");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it("preserves all prior messages including the full tool result on follow-up", () => {
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
      messages: [...withToolResult.messages, { role: "user", content: "user2", timestamp: 4 }],
    };

    const first = convertMessages(model, turn1, compat());
    const beforeFollowUp = convertMessages(model, withToolResult, compat());
    const afterFollowUp = convertMessages(model, followUp, compat());

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
    expect(afterFollowUp.at(-1)).toEqual({ role: "user", content: "user2" });
  });

  it("keeps trailing hook guidance in the system message", () => {
    const context: Context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}## Team\nAlways answer in German.`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    };

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\n## Team\nAlways answer in German.");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

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
      name: "missing closing marker",
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime facts`,
      expectedSystem: "Stable prefix\nRuntime facts",
    },
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
      name: "literal opening before the complete region",
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Retry guidance${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${marked("Runtime facts")}`,
      expectedSystem: "Stable prefix\nRetry guidance\nReactions guidance\nRuntime facts",
    },
    {
      name: "literal closing before the complete region",
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\nRetry guidance${marked("Runtime facts")}`,
      expectedSystem: "Stable prefix\nRetry guidance\nRuntime facts",
    },
    {
      name: "two complete regions",
      systemPrompt: `Stable prefix${marked("Retry guidance")}${marked("Runtime facts")}`,
      expectedSystem: "Stable prefix\nRetry guidance\nRuntime facts",
    },
    {
      name: "duplicate opening after the complete region",
      systemPrompt: `Stable prefix${marked("Runtime facts")}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Retry guidance`,
      expectedSystem: "Stable prefix\nRuntime facts\nRetry guidance",
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
