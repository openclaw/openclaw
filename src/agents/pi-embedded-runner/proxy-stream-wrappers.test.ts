import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  createReasoningContentNormalizerWrapper,
} from "./proxy-stream-wrappers.js";

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({
        headers: options?.headers,
      });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "X-OpenRouter-Categories": "cli-agent",
          "X-Custom": "1",
        },
      },
    ]);
  });

  it("injects cache_control markers for declared OpenRouter Anthropic models on the default route", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not inject cache_control markers for declared OpenRouter providers on custom proxy URLs", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it("injects cache_control markers for native OpenRouter hosts behind custom provider ids", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "custom-openrouter",
        id: "anthropic/claude-sonnet-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("createReasoningContentNormalizerWrapper", () => {
  it("renames reasoning to reasoning_content on assistant messages for non-OpenRouter endpoints", () => {
    const payload = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi", reasoning: "the model thought about greeting" },
      ],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "zenmux",
        id: "deepseek-v4-flash",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const msg = payload.messages[1] as Record<string, unknown>;
    expect(msg.reasoning_content).toBe("the model thought about greeting");
    expect(msg.reasoning).toBeUndefined();
  });

  it("does not rename on OpenRouter endpoints", () => {
    const payload = {
      messages: [{ role: "assistant", content: "hi", reasoning: "keep me" }],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "deepseek/deepseek-r1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const msg = payload.messages[0] as Record<string, unknown>;
    expect(msg.reasoning).toBe("keep me");
    expect(msg.reasoning_content).toBeUndefined();
  });

  it("does not double-set reasoning_content if already present", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "hi", reasoning_content: "existing", reasoning: "extra" },
      ],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "zenmux",
        id: "deepseek-v4-flash",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const msg = payload.messages[0] as Record<string, unknown>;
    expect(msg.reasoning_content).toBe("existing");
    expect(msg.reasoning).toBe("extra");
  });

  it("skips non-openai-completions APIs", () => {
    const payload = {
      messages: [{ role: "assistant", content: "hi", reasoning: "should survive" }],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
      { messages: [] },
      {},
    );

    const msg = payload.messages[0] as Record<string, unknown>;
    expect(msg.reasoning).toBe("should survive");
    expect(msg.reasoning_content).toBeUndefined();
  });

  it("does not touch non-assistant messages that happen to have reasoning", () => {
    const payload = {
      messages: [
        { role: "user", content: "hello", reasoning: "user-reasoning" },
        { role: "assistant", content: "hi" },
      ],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "zenmux",
        id: "deepseek-v4-flash",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const userMsg = payload.messages[0] as Record<string, unknown>;
    expect(userMsg.reasoning).toBe("user-reasoning");
    expect(userMsg.reasoning_content).toBeUndefined();

    const asstMsg = payload.messages[1] as Record<string, unknown>;
    expect(asstMsg.reasoning).toBeUndefined();
  });

  it("leaves messages without reasoning unchanged", () => {
    const payload = {
      messages: [{ role: "assistant", content: "plain response" }],
    };
    const wrapped = createReasoningContentNormalizerWrapper(((_m, _c, options) => {
      options?.onPayload?.(payload, _m);
      return createAssistantMessageEventStream();
    }) as StreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "zenmux",
        id: "deepseek-v4-flash",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const msg = payload.messages[0] as Record<string, unknown>;
    expect(msg.content).toBe("plain response");
    expect(msg.reasoning).toBeUndefined();
    expect(msg.reasoning_content).toBeUndefined();
  });
});
