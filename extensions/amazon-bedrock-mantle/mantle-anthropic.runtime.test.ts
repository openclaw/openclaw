import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { stream, type Model, type SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  notifyProviderStreamOpened,
  withProviderAcceptanceObserver,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMantleAnthropicStreamFn } from "./mantle-anthropic.runtime.js";

// Keep real defaults for the payload boundary proof; only synthetic cases replace them.
vi.mock("@anthropic-ai/sdk", { spy: true });
vi.mock("openclaw/plugin-sdk/llm", { spy: true });
afterEach(() => vi.resetAllMocks());

function createTestModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "amazon-bedrock-mantle",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    headers: { "X-Test": "model-header" },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  } as Model;
}

const streamMock = vi.mocked(stream);
const clientMock = vi.mocked(Anthropic);
function mockTransport() {
  clientMock.mockImplementation(function (options) {
    return { options } as never;
  });
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function firstStreamOptions(model: Model, context: unknown) {
  const [actualModel, actualContext, options] = streamMock.mock.calls[0] ?? [];
  expect(actualModel).toBe(model);
  expect(actualContext).toBe(context);
  return requireRecord(options, "stream options");
}

function captureStreamOptions(model: Model, options: SimpleStreamOptions = {}) {
  const context = { messages: [] };
  mockTransport();
  streamMock.mockReturnValue({ kind: "anthropic-stream" } as never);
  void createMantleAnthropicStreamFn()(model, context, {
    apiKey: "bedrock-bearer-token",
    ...options,
  });
  return firstStreamOptions(model, context);
}

function createReasoningModel(id: string, name: string, overrides: Partial<Model> = {}) {
  return createTestModel({
    id: `anthropic.${id}`,
    name,
    reasoning: true,
    params: { canonicalModelId: id },
    ...overrides,
  });
}

describe("createMantleAnthropicStreamFn", () => {
  it("keeps the stable system prefix independently cacheable with long retention", async () => {
    for (const suffix of ["Today: Monday", "Today: Tuesday"]) {
      let payload: unknown;
      const events = await createMantleAnthropicStreamFn()(
        createTestModel(),
        {
          systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}`,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        {
          apiKey: "synthetic-test-key",
          cacheRetention: "long",
          onPayload: (request) => {
            payload = request;
            throw new Error("payload captured before network");
          },
        },
      );
      await events.result();
      const request = requireRecord(payload, "Mantle payload");
      expect(JSON.stringify(request)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
      expect(request.system).toEqual([
        { type: "text", text: "Stable", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: suffix },
      ]);
      expect(JSON.stringify(request).match(/"cache_control"/g)?.length).toBeLessThanOrEqual(4);
    }
  });

  it("uses authToken bearer auth for Mantle Anthropic requests", async () => {
    const resultStream = { kind: "anthropic-stream" };
    const model = createTestModel();
    const context = { messages: [] };
    mockTransport();
    streamMock.mockReturnValue(resultStream as never);
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver(
      {
        apiKey: "bedrock-bearer-token",
        onResponse,
        headers: { "X-Caller": "caller-header" },
      },
      acceptanceObserver,
    );
    const result = createMantleAnthropicStreamFn()(model, context, options);
    expect(result).toBe(resultStream);
    const clientOptions = requireRecord(clientMock.mock.calls[0]?.[0], "client options");
    expect(clientOptions).toMatchObject({
      apiKey: null,
      authToken: "bedrock-bearer-token",
      baseURL: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      fetch: expect.any(Function),
    });
    expect(JSON.stringify(clientOptions.defaultHeaders)).toBe(
      '{"accept":"application/json","anthropic-dangerous-direct-browser-access":"true","anthropic-beta":"fine-grained-tool-streaming-2025-05-14","X-Test":"model-header","X-Caller":"caller-header"}',
    );
    const streamOptions = firstStreamOptions(model, context);
    const client = requireRecord(streamOptions.client, "stream client");
    expect(requireRecord(client.options, "stream client options").authToken).toBe(
      "bedrock-bearer-token",
    );
    expect(streamOptions.thinkingEnabled).toBe(false);
    expect(streamOptions.onResponse).toBe(onResponse);
    await notifyProviderStreamOpened({ options: streamOptions, cancelStream: vi.fn() });
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it.each([
    { reasoning: "max" as const, effort: "high" },
    { reasoning: "minimal" as const, effort: "low" },
  ])("maps Mythos Preview $reasoning reasoning to $effort", ({ reasoning, effort }) => {
    const options = captureStreamOptions(
      createReasoningModel("claude-mythos-preview", "Claude Mythos Preview"),
      { reasoning },
    );
    expect(options).toMatchObject({ thinkingEnabled: true, effort });
  });

  it.each([
    { id: "opus", name: "Opus", reasoning: "max", effort: "max" },
    { id: "sonnet", name: "Sonnet", reasoning: undefined, effort: "high" },
    { id: "sonnet", name: "Sonnet", reasoning: "off", effort: "low" },
  ] as const)(
    "keeps $name 5 adaptive for reasoning=$reasoning",
    ({ id, name, reasoning, effort }) => {
      const options = captureStreamOptions(
        createReasoningModel(`claude-${id}-5`, `Claude ${name} 5`),
        { reasoning, temperature: 0.2 },
      );
      expect(options).toMatchObject({ thinkingEnabled: true, effort, maxTokens: 128_000 });
      expect(options).not.toHaveProperty("temperature");
    },
  );

  it("disables legacy thinking when the adjusted budget is below 1024", () => {
    const options = captureStreamOptions(
      createReasoningModel("claude-haiku-4-5", "Claude Haiku 4.5", { maxTokens: 1500 }),
      { reasoning: "low" },
    );
    expect(options).toMatchObject({ maxTokens: 1500, thinkingEnabled: false });
    expect(options).not.toHaveProperty("thinkingBudgetTokens");
  });

  it("preserves Mantle's xhigh legacy budget independently of high", () => {
    const thinkingBudgets = { high: 4096, xhigh: 6144 };
    const options = captureStreamOptions(
      createReasoningModel("claude-haiku-4-5", "Claude Haiku 4.5"),
      { reasoning: "xhigh", thinkingBudgets, maxTokens: 2048 },
    );
    expect(options).toMatchObject({
      maxTokens: 2048 + 6144,
      thinkingEnabled: true,
      thinkingBudgetTokens: 6144,
    });
  });

  it("defaults Mythos 5 to adaptive high reasoning", () => {
    const options = captureStreamOptions(
      createReasoningModel("claude-mythos-5", "Claude Mythos 5", {
        thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
      }),
      { maxTokens: 1_000, temperature: 0.2 },
    );
    expect(options).toMatchObject({ thinkingEnabled: true, effort: "high", maxTokens: 1_000 });
    expect(options).not.toHaveProperty("thinkingBudgetTokens");
    expect(options.temperature).toBeUndefined();
  });
});
