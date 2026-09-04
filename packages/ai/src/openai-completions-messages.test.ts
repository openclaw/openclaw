import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
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

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

describe("convertMessages relocatable suffix", () => {
  const compat = () => resolveOpenAICompletionsCompat(model);
  const contextForSession = (sessionId: string): Context =>
    ({
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}## Runtime\nRuntime: session=${sessionId}`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }) as unknown as Context;

  it("carries the non-behavioral tail on the trailing user turn", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(converted[0]).toEqual({
      role: "system",
      content: "Stable prefix\nReactions guidance",
    });
    expect(converted[1]?.content).toBe("hi\n\n## Runtime\nRuntime: session=alpha");
  });

  it("keeps behavioral guidance at system authority", () => {
    // Only the tail below the relocatable marker moves. Everything above it,
    // including guidance that merely sits below the cache boundary, stays in
    // the system message.
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(converted[0]?.content).toContain("Reactions guidance");
    expect(converted[1]?.content).not.toContain("Reactions guidance");
  });

  it("does not relocate when only the cache boundary is present", () => {
    const context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\nReactions guidance");
    expect(converted[1]?.content).toBe("hi");
  });

  it("keeps the system message byte-identical across sessions", () => {
    const first = convertMessages(model, contextForSession("alpha"), compat());
    const second = convertMessages(model, contextForSession("beta"), compat());

    expect(first[0]).toEqual(second[0]);
    expect(first[1]?.content).not.toEqual(second[1]?.content);
  });

  it("keeps the tail in the system prompt when the only user turn projects away", () => {
    // Media projection can leave a user turn with no renderable content, and the
    // converter skips it. The tail must survive rather than vanish with it.
    const context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime facts`,
      messages: [{ role: "user", content: [], timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted).toHaveLength(1);
    expect(converted[0]?.content).toBe("Stable prefix\nRuntime facts");
  });

  it("never leaks an internal marker to the provider", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(JSON.stringify(converted)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(JSON.stringify(converted)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
  });

  it("leaves the boundary in place when the caller preserves it", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat(), {
      preserveSystemPromptCacheBoundary: true,
    });

    expect(converted[0]?.content).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY.trim());
    expect(converted[1]?.content).toBe("hi");
  });

  it("leaves a trailing structural marker in the system prompt", () => {
    // The attempt-section marker closes a region of the system prompt; it must
    // not ride onto the user turn with the relocated facts.
    const context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime: session=alpha\n<!-- /openclaw:attempt:DYNAMIC -->`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\n<!-- /openclaw:attempt:DYNAMIC -->");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it("marks the carrying turn as cache opt-out", () => {
    const cacheOptOutIndexes = new Set<number>();

    convertMessages(model, contextForSession("alpha"), compat(), { cacheOptOutIndexes });

    expect(cacheOptOutIndexes.has(1)).toBe(true);
  });
});
