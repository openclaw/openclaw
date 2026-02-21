import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { Model, Context } from "@mariozechner/pi-ai";
import { describe, it, expect } from "vitest";
import { applyExtraParamsToAgent } from "./pi-embedded-runner/extra-params.js";

describe("applyExtraParamsToAgent", () => {
  it("adds OpenRouter attribution headers for openrouter", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return undefined as unknown as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openai/gpt-4o");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openai/gpt-4o",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
      "X-Custom": "1",
    });
  });

  it("adds OpenRouter attribution headers for openrouter-passthrough", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return undefined as unknown as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter-passthrough",
      "anthropic/claude-opus-4.6",
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter-passthrough",
      id: "anthropic/claude-opus-4.6",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
      "X-Custom": "1",
    });
  });

  it("passes cacheRetention for openrouter-passthrough with Anthropic model", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return undefined as unknown as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter-passthrough",
      "anthropic/claude-opus-4.6",
      { cacheRetention: "long" },
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter-passthrough",
      id: "anthropic/claude-opus-4.6",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>)?.cacheRetention).toBe("long");
  });

  it("passes cacheRetention for openrouter with Anthropic model", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return undefined as unknown as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openrouter",
      "anthropic/claude-sonnet-4-5-20250929",
      { cacheRetention: "short" },
    );

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4-5-20250929",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>)?.cacheRetention).toBe("short");
  });

  it("does not pass cacheRetention for openrouter-passthrough with non-Anthropic model", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return undefined as unknown as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter-passthrough", "openai/gpt-4", {
      cacheRetention: "long",
    });

    const model = {
      api: "openai-completions",
      provider: "openrouter-passthrough",
      id: "openai/gpt-4",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    // streamFn should still exist (for headers) but cacheRetention should not be set
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>)?.cacheRetention).toBeUndefined();
  });
});
