import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent, createProviderHeadersWrapper } from "./extra-params.js";

// Mock streamSimple for testing
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

describe("createProviderHeadersWrapper", () => {
  it("injects provider headers into the stream call", () => {
    let capturedHeaders: Record<string, string> | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      capturedHeaders = options?.headers;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createProviderHeadersWrapper(baseFn, { "User-Agent": "claude-code/0.1.0" });
    const model = {
      api: "anthropic-messages",
      provider: "kimi-coding",
      id: "k2p5",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void wrapped(model, context, {});

    expect(capturedHeaders).toEqual({ "User-Agent": "claude-code/0.1.0" });
  });

  it("allows call-site headers to override provider headers", () => {
    let capturedHeaders: Record<string, string> | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      capturedHeaders = options?.headers;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createProviderHeadersWrapper(baseFn, {
      "User-Agent": "provider-default",
      "X-Custom": "from-provider",
    });
    const model = {
      api: "anthropic-messages",
      provider: "test",
      id: "m1",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void wrapped(model, context, {
      headers: { "User-Agent": "call-site-override" },
    } as SimpleStreamOptions);

    expect(capturedHeaders).toEqual({
      "User-Agent": "call-site-override",
      "X-Custom": "from-provider",
    });
  });
});

describe("applyExtraParamsToAgent with providerHeaders", () => {
  it("injects provider headers when providerHeaders is provided", () => {
    let capturedHeaders: Record<string, string> | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      capturedHeaders = options?.headers;
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "kimi-coding",
      "k2p5",
      undefined,
      undefined,
      undefined,
      { "User-Agent": "claude-code/0.1.0" },
    );

    const model = {
      api: "anthropic-messages",
      provider: "kimi-coding",
      id: "k2p5",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(capturedHeaders).toEqual({ "User-Agent": "claude-code/0.1.0" });
  });

  it("does not wrap streamFn when providerHeaders is empty", () => {
    const baseFn: StreamFn = (_model, _context, _options) => {
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "some-provider",
      "some-model",
      undefined,
      undefined,
      undefined,
      {},
    );

    // streamFn will be wrapped by other wrappers (e.g. Google thinking sanitizer,
    // OpenAI Responses), but not by the provider headers wrapper.
    // We verify by calling and checking no provider headers appear.
    let capturedHeaders: Record<string, string> | undefined;
    const probeBaseFn: StreamFn = (_model, _context, options) => {
      capturedHeaders = options?.headers;
      return {} as ReturnType<StreamFn>;
    };
    const probeAgent = { streamFn: probeBaseFn };

    applyExtraParamsToAgent(
      probeAgent,
      undefined,
      "some-provider",
      "some-model",
      undefined,
      undefined,
      undefined,
      {},
    );

    const model = {
      api: "openai-completions",
      provider: "some-provider",
      id: "some-model",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void probeAgent.streamFn?.(model, context, {});

    expect(capturedHeaders).toBeUndefined();
  });
});
