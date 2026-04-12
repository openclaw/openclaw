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

  it("coerces replayed malformed tool-call args to an object for Anthropic payloads", async () => {
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
          messages: [
            {
              role: "assistant",
              provider: "openai",
              api: "openai-responses",
              model: "gpt-5.4",
              stopReason: "toolUse",
              timestamp: 0,
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "lookup",
                  arguments: "{not valid json",
                },
              ],
            },
          ],
        } as never,
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              name: "lookup",
              input: {},
            }),
          ]),
        }),
      ]),
    );
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

  it("uses mixed Anthropic cache TTLs and injects native compaction edits when enabled", async () => {
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
          systemPrompt: "Follow policy.",
          messages: [{ role: "user", content: "Keep coding." }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          cacheRetention: "long",
          anthropicServerCompaction: true,
          anthropicCompactThreshold: 123_456,
          anthropicCompactPauseAfter: true,
          anthropicCompactInstructions: "Preserve important code decisions.",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          "anthropic-beta": expect.stringContaining("context-management-2025-06-27"),
        }),
      }),
    );
    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.system).toEqual([
      {
        type: "text",
        text: "Follow policy.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    expect(firstCallParams.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Keep coding.", cache_control: { type: "ephemeral" } }],
      },
    ]);
    expect(firstCallParams.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 123_456 },
          pause_after_compaction: true,
          instructions: "Preserve important code decisions.",
        },
      ],
    });
  });

  it("round-trips Anthropic compaction blocks in requests and streamed responses", async () => {
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { id: "msg_compact", usage: { input_tokens: 25, output_tokens: 0 } },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "compaction", content: "" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "compaction_delta", content: "Summarized old context." },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "compaction" },
          usage: { input_tokens: 25, output_tokens: 10 },
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
          messages: [
            {
              role: "assistant",
              provider: "anthropic",
              api: "anthropic-messages",
              model: "claude-sonnet-4-6",
              stopReason: "stop",
              timestamp: 0,
              content: [{ type: "compaction", content: "Earlier compacted summary." }],
            },
            { role: "user", content: "Continue." },
          ],
        } as never,
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const eventsPromise = (async () => {
      const events: Array<{ type?: string }> = [];
      for await (const event of stream) {
        events.push(event as { type?: string });
      }
      return events;
    })();
    const result = await stream.result();
    const events = await eventsPromise;

    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          "anthropic-beta": expect.stringContaining("compact-2026-01-12"),
        }),
      }),
    );
    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "compaction",
              content: "Earlier compacted summary.",
            }),
          ]),
        }),
      ]),
    );
    expect(result.stopReason).toBe("compaction");
    expect(events.some((event) => event.type === "text_start" || event.type === "text_delta")).toBe(
      false,
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compaction",
          content: "Summarized old context.",
        }),
      ]),
    );
  });

  it("drops compaction history blocks before sending GitHub Copilot Anthropic requests", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
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
          messages: [
            {
              role: "assistant",
              provider: "anthropic",
              api: "anthropic-messages",
              model: "claude-sonnet-4-6",
              stopReason: "stop",
              timestamp: 0,
              content: [{ type: "compaction", content: "Earlier compacted summary." }],
            },
            { role: "user", content: "Continue." },
          ],
        } as never,
        {
          apiKey: "gho_test",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }],
      },
    ]);
    expect(
      anthropicCtorMock.mock.calls[0]?.[0]?.defaultHeaders?.["anthropic-beta"] ?? "",
    ).not.toContain("compact-2026-01-12");
  });

  it("preserves string assistant content when stripping compaction blocks for Copilot transport", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
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
          messages: [
            {
              role: "assistant",
              provider: "anthropic",
              api: "anthropic-messages",
              model: "claude-sonnet-4-6",
              stopReason: "stop",
              timestamp: 0,
              content: "Earlier plain assistant text.",
            },
            { role: "user", content: "Continue." },
          ],
        } as never,
        {
          apiKey: "gho_test",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier plain assistant text." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });
});
