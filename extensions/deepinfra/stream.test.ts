import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createDeepInfraSystemCacheWrapper, createDeepInfraWrapper } from "./stream.js";

describe("deepinfra stream wrappers", () => {
  it("injects cache_control markers for Anthropic models on DeepInfra", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not inject cache_control markers for non-Anthropic models on DeepInfra", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it("normalizes reasoning payload for DeepInfra with thinking level", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { messages: [] };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraWrapper(baseStreamFn, "medium");
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(capturedPayloads[0]).toEqual({
      messages: [],
      reasoning: { effort: "medium" },
    });
  });

  it("does not add reasoning payload for DeepInfra with thinking off", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { messages: [] };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraWrapper(baseStreamFn, "off");
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(capturedPayloads[0]).toEqual({ messages: [] });
  });

  // DeepInfra's reasoning.effort vocabulary differs from OpenClaw's
  // thinkingLevel vocabulary — these mappings are lossy and non-obvious, so
  // lock them in. "adaptive" → "medium" and "max" → "xhigh" are the two
  // rewrites; other levels pass through verbatim.
  const THINKING_LEVEL_CASES: Array<{
    input: "minimal" | "low" | "medium" | "high" | "adaptive" | "max";
    expected: "minimal" | "low" | "medium" | "high" | "xhigh";
  }> = [
    { input: "minimal", expected: "minimal" },
    { input: "low", expected: "low" },
    { input: "medium", expected: "medium" },
    { input: "high", expected: "high" },
    { input: "adaptive", expected: "medium" },
    { input: "max", expected: "xhigh" },
  ];

  for (const { input, expected } of THINKING_LEVEL_CASES) {
    it(`maps thinkingLevel "${input}" to reasoning.effort "${expected}"`, () => {
      const capturedPayloads: unknown[] = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload = { messages: [] };
        options?.onPayload?.(payload, _model);
        capturedPayloads.push(payload);
        return createAssistantMessageEventStream();
      };

      const wrapped = createDeepInfraWrapper(baseStreamFn, input);
      void wrapped(
        {
          api: "openai-completions",
          provider: "deepinfra",
          id: "anthropic/claude-4-sonnet",
        } as Model<"openai-completions">,
        { messages: [] },
        {},
      );

      expect(capturedPayloads[0]).toEqual({
        messages: [],
        reasoning: { effort: expected },
      });
    });
  }

  // DeepInfra's OpenAI-compat surface accepts both top-level `reasoning_effort`
  // and the nested `reasoning.effort` shape; we normalize to the nested shape
  // and actively strip the flat key so upstream pi-agent-core can't double-send
  // or override what the wrapper just set.
  it("strips top-level reasoning_effort before dispatch", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        reasoning_effort: "low",
      };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraWrapper(baseStreamFn, "high");
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(capturedPayloads[0]).toEqual({
      messages: [],
      reasoning: { effort: "high" },
    });
  });

  it("preserves a pre-existing reasoning.effort and does not overwrite", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { messages: [], reasoning: { effort: "low" } };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraWrapper(baseStreamFn, "high");
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(capturedPayloads[0]).toEqual({
      messages: [],
      reasoning: { effort: "low" },
    });
  });

  it("preserves a pre-existing reasoning.max_tokens and does not add effort", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { messages: [], reasoning: { max_tokens: 4096 } };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraWrapper(baseStreamFn, "high");
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(capturedPayloads[0]).toEqual({
      messages: [],
      reasoning: { max_tokens: 4096 },
    });
  });

  it("injects cache_control markers case-insensitively on the model id prefix", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createDeepInfraSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "Anthropic/Claude-4-Sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("chains DeepInfra reasoning + cache wrappers for Anthropic models", () => {
    const capturedPayloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: [{ role: "system", content: "system prompt" }],
      };
      options?.onPayload?.(payload, _model);
      capturedPayloads.push(payload);
      return createAssistantMessageEventStream();
    };

    // Chain as in index.ts: reasoning wrapper first, then cache wrapper
    let streamFn = createDeepInfraWrapper(baseStreamFn, "high");
    streamFn = createDeepInfraSystemCacheWrapper(streamFn);

    void streamFn(
      {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-4-sonnet",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    const payload = capturedPayloads[0] as Record<string, unknown>;
    // Reasoning was normalized
    expect(payload.reasoning).toEqual({ effort: "high" });
    // Cache markers were injected on system message
    expect((payload.messages as Array<{ content: unknown }>)[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });
});
