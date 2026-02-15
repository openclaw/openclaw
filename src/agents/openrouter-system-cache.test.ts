import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithSystemCacheControl } from "./openrouter-system-cache.js";

// Minimal model stubs matching StreamFn's model parameter shape
const openRouterAnthropicModel = {
  provider: "openrouter",
  id: "anthropic/claude-opus-4-6",
  api: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
} as Parameters<StreamFn>[0];

const openaiModel = {
  provider: "openai",
  id: "gpt-4o",
  api: "openai",
  baseUrl: "https://api.openai.com/v1",
} as Parameters<StreamFn>[0];

const fakeContext = { messages: [], systemPrompt: "" } as Parameters<StreamFn>[1];
const fakeStream = { [Symbol.asyncIterator]: () => ({}) } as ReturnType<StreamFn>;

type Params = Record<string, unknown>;
type MsgArray = Array<{ role: string; content: unknown }>;

function makeInnerStreamFn(paramsFactory: () => Params): [StreamFn, () => Params | undefined] {
  let captured: Params | undefined;
  const fn = vi.fn(
    (
      _model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options?: Record<string, unknown>,
    ) => {
      const params = paramsFactory();
      (options?.onPayload as ((p: Params) => void) | undefined)?.(params);
      captured = params;
      return fakeStream;
    },
  ) as unknown as StreamFn;
  return [fn, () => captured];
}

describe("wrapStreamFnWithSystemCacheControl", () => {
  it("adds cache_control to string system message content", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      model: "anthropic/claude-opus-4-6",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {});

    const systemMsg = (getParams()!.messages as MsgArray)[0];
    expect(systemMsg.role).toBe("system");
    expect(Array.isArray(systemMsg.content)).toBe(true);
    expect((systemMsg.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "text",
      text: "You are a helpful assistant.",
      cache_control: { type: "ephemeral" },
    });
  });

  it("adds cache_control to last text part of array system message content", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      model: "anthropic/claude-opus-4-6",
      messages: [
        {
          role: "developer",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
        { role: "user", content: "Hello" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {});

    const systemMsg = (getParams()!.messages as MsgArray)[0];
    const content = systemMsg.content as Array<Record<string, unknown>>;
    expect(systemMsg.role).toBe("developer");
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves existing onPayload callback", () => {
    const originalOnPayload = vi.fn();

    const [inner] = makeInnerStreamFn(() => ({
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {
      onPayload: originalOnPayload,
    });

    expect(originalOnPayload).toHaveBeenCalledTimes(1);
  });

  it("does not modify non-OpenRouter models", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openaiModel, fakeContext, {});

    const systemMsg = (getParams()!.messages as MsgArray)[0];
    expect(typeof systemMsg.content).toBe("string");
  });

  it("does not modify non-Anthropic OpenRouter models", () => {
    const nonAnthropicModel = {
      ...openRouterAnthropicModel,
      id: "google/gemini-pro",
    } as Parameters<StreamFn>[0];

    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(nonAnthropicModel, fakeContext, {});

    const systemMsg = (getParams()!.messages as MsgArray)[0];
    expect(typeof systemMsg.content).toBe("string");
  });

  it("handles messages with no system message gracefully", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {});

    expect((getParams()!.messages as MsgArray)[0].content).toBe("Hello");
  });

  it("skips malformed message entries without throwing", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: ["not-an-object", { role: "system", content: "System prompt" }],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    expect(() => wrapped(openRouterAnthropicModel, fakeContext, {})).not.toThrow();

    const systemMsg = (getParams()!.messages as MsgArray)[1];
    expect(Array.isArray(systemMsg.content)).toBe(true);
  });

  it("falls through to later system/developer message when first has no text parts", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: [
        { role: "system", content: [{ type: "image", source: "x" }] },
        { role: "developer", content: "System fallback" },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {});

    const messages = getParams()!.messages as MsgArray;
    expect(messages[0].content).toEqual([{ type: "image", source: "x" }]);
    expect(messages[1].content).toEqual([
      {
        type: "text",
        text: "System fallback",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("preserves existing cache_control on text parts", () => {
    const [inner, getParams] = makeInnerStreamFn(() => ({
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "System prompt",
              cache_control: { type: "persistent" },
            },
          ],
        },
      ],
    }));

    const wrapped = wrapStreamFnWithSystemCacheControl(inner);
    void wrapped(openRouterAnthropicModel, fakeContext, {});

    const systemMsg = (getParams()!.messages as MsgArray)[0];
    expect(systemMsg.content).toEqual([
      {
        type: "text",
        text: "System prompt",
        cache_control: { type: "persistent" },
      },
    ]);
  });
});
