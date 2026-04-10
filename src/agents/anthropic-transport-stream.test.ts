import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const {
  anthropicCtorMock,
  anthropicMessagesStreamMock,
  buildGuardedModelFetchMock,
  guardedFetchMock,
} = vi.hoisted(() => ({
  anthropicCtorMock: vi.fn(),
  anthropicMessagesStreamMock: vi.fn(),
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicCtorMock,
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

function emptyEventStream(): AsyncIterable<Record<string, unknown>> {
  return (async function* () {})();
}

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    anthropicCtorMock.mockReset();
    anthropicMessagesStreamMock.mockReset();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    anthropicMessagesStreamMock.mockReturnValue(emptyEventStream());
    anthropicCtorMock.mockImplementation(function mockAnthropicClient() {
      return {
        messages: {
          stream: anthropicMessagesStreamMock,
        },
      };
    });
  });

  it("uses the guarded fetch transport for api-key Anthropic requests", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        headers: { "X-Provider": "anthropic" },
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          headers: { "X-Call": "1" },
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ant-api",
        baseURL: "https://api.anthropic.com",
        fetch: guardedFetchMock,
        defaultHeaders: expect.objectContaining({
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "X-Provider": "anthropic",
          "X-Call": "1",
        }),
      }),
    );
    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        stream: true,
      }),
      undefined,
    );
  });

  it("preserves Anthropic OAuth identity and tool-name remapping with transport overrides", async () => {
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { path: "/tmp/a" },
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })(),
    );
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "Follow policy.",
          messages: [{ role: "user", content: "Read the file" }],
          tools: [
            {
              name: "read",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                },
                required: ["path"],
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-oat-example",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: "sk-ant-oat-example",
        fetch: guardedFetchMock,
        defaultHeaders: expect.objectContaining({
          "x-app": "cli",
          "user-agent": expect.stringContaining("claude-cli/"),
        }),
      }),
    );
    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        }),
        expect.objectContaining({
          text: "Follow policy.",
        }),
      ]),
    );
    expect(firstCallParams.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Read" })]),
    );
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "read" })]),
    );
  });

  it("processes advisor tool flow: server_tool_use + advisor_tool_result + text", async () => {
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { id: "msg_123", usage: { input_tokens: 100, output_tokens: 50 } },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "server_tool_use",
            id: "toolu_123",
            name: "advisor",
            input: {},
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "advisor_tool_result",
            tool_use_id: "toolu_123",
            content: { type: "advisor_result", text: "The advisor says hello." },
          },
        };
        yield {
          type: "content_block_stop",
          index: 1,
        };
        yield {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "Here is my response." },
        };
        yield {
          type: "content_block_stop",
          index: 2,
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 100, output_tokens: 50 },
        };
        yield { type: "message_stop" };
      })(),
    );

    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        headers: { "X-Provider": "anthropic" },
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "Ask the advisor something." }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    // 2 blocks: advisor display text + model response (server_tool_use silently dropped)
    expect(result.content).toHaveLength(2);

    // Block 0: advisor result → display-only text (serverToolDisplay skipped on API replay)
    const block0 = result.content[0] as {
      type: string;
      text?: string;
      serverToolDisplay?: boolean;
    };
    expect(block0.type).toBe("text");
    expect(block0.text).toBe("[Advisor] The advisor says hello.");
    expect(block0.serverToolDisplay).toBe(true);

    // Block 1: model's final response
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: "Here is my response.",
    });

    // Stop reason mapped from "end_turn" → "stop"
    expect(result.stopReason).toBe("stop");
  });

  it("displays redacted advisor results as encrypted placeholder text", async () => {
    const redactedBlock = {
      type: "advisor_tool_result",
      tool_use_id: "toolu_redacted",
      content: { type: "advisor_redacted_result", encrypted_content: "opaque_blob_abc123" },
    };
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { id: "msg_redacted", usage: { input_tokens: 50, output_tokens: 20 } },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: redactedBlock,
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Response after advisor." },
        };
        yield { type: "content_block_stop", index: 1 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 50, output_tokens: 20 },
        };
        yield { type: "message_stop" };
      })(),
    );

    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      { proxy: { mode: "env-proxy" } },
    );

    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "Test redacted advisor." }],
        } as Parameters<typeof streamFn>[1],
        { apiKey: "sk-ant-api" } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    // 2 blocks: encrypted display text + response text (no round-trip, no opaque blocks)
    expect(result.content).toHaveLength(2);

    // Block 0: redacted advisor result → display-only text
    const displayBlock = result.content[0] as {
      type: string;
      text?: string;
      serverToolDisplay?: boolean;
    };
    expect(displayBlock.type).toBe("text");
    expect(displayBlock.text).toBe("[Advisor output (encrypted)]");
    expect(displayBlock.serverToolDisplay).toBe(true);

    // Block 1: regular text
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: "Response after advisor.",
    });
  });

  it("maps adaptive thinking effort for Claude 4.6 transport runs", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "env-proxy",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "Think deeply." }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          reasoning: "xhigh",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: "adaptive" },
        output_config: { effort: "max" },
      }),
      undefined,
    );
  });
});

describe("mapStopReason resilience", () => {
  let mapStopReason: (reason: string | undefined) => string;

  beforeAll(async () => {
    ({ mapStopReason } = (await import("./anthropic-transport-stream.js")).__testing);
  });

  it("maps known stop reasons correctly", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("pause_turn")).toBe("stop");
    expect(mapStopReason("refusal")).toBe("error");
    expect(mapStopReason("sensitive")).toBe("error");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("model_context_window_exceeded")).toBe("length");
    expect(mapStopReason("compaction")).toBe("length");
  });

  it("does not throw on unrecognized stop_reason values", () => {
    expect(mapStopReason("some_future_reason")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });
});

describe("server-side tool block handling", () => {
  let isServerToolUseBlock: (block: Record<string, unknown>) => boolean;
  let translateServerToolResultBlock: (block: Record<string, unknown>) => string | null;

  beforeAll(async () => {
    const mod = await import("./anthropic-transport-stream.js");
    isServerToolUseBlock = mod.__testing.isServerToolUseBlock;
    translateServerToolResultBlock = mod.__testing.translateServerToolResultBlock;
  });

  it("identifies server_tool_use blocks", () => {
    expect(
      isServerToolUseBlock({
        type: "server_tool_use",
        id: "toolu_123",
        name: "web_search",
        input: { query: "test" },
      }),
    ).toBe(true);
  });

  it("returns false for non-server_tool_use blocks", () => {
    expect(isServerToolUseBlock({ type: "text" })).toBe(false);
    expect(isServerToolUseBlock({ type: "tool_use" })).toBe(false);
  });

  it("translates advisor_tool_result with advisor_result content", () => {
    const block = {
      type: "advisor_tool_result",
      tool_use_id: "toolu_123",
      content: { type: "advisor_result", text: "The answer is 42." },
    };
    expect(translateServerToolResultBlock(block)).toBe("[Advisor] The answer is 42.");
  });

  it("translates advisor_tool_result with redacted content", () => {
    const block = {
      type: "advisor_tool_result",
      tool_use_id: "toolu_456",
      content: { type: "advisor_redacted_result", encrypted_content: "abc123" },
    };
    expect(translateServerToolResultBlock(block)).toBe("[Advisor output (encrypted)]");
  });

  it("translates advisor_tool_result with error", () => {
    const block = {
      type: "advisor_tool_result",
      tool_use_id: "toolu_789",
      content: { type: "advisor_tool_result_error", error_code: "overloaded" },
    };
    expect(translateServerToolResultBlock(block)).toBe("[Advisor error: overloaded]");
  });

  it("translates generic *_tool_result blocks", () => {
    const block = {
      type: "web_search_tool_result",
      tool_use_id: "toolu_abc",
      content: [{ type: "web_search_result", url: "https://example.com" }],
    };
    // Untranslatable result — returns empty (still round-tripped, no display text)
    expect(translateServerToolResultBlock(block)).toBe("");
  });

  it("returns null for non-tool-result blocks", () => {
    expect(translateServerToolResultBlock({ type: "text" })).toBeNull();
    expect(translateServerToolResultBlock({ type: "tool_use" })).toBeNull();
  });
});
