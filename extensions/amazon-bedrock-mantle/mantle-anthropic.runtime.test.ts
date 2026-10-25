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
const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function firstStreamOptions(model: Model, context: unknown) {
  const [actualModel, actualContext, options] = streamMock.mock.calls[0] ?? [];
  expect(actualModel).toBe(model);
  expect(actualContext).toBe(context);
  return requireRecord(options, "stream options");
}

function captureStreamOptions(model: Model, options: SimpleStreamOptions = {}) {
  const context = { messages: [] };
  clientMock.mockImplementation(function (clientOptions) {
    return { options: clientOptions } as never;
  });
  const resultStream = { kind: "anthropic-stream" };
  streamMock.mockReturnValue(resultStream as never);
  const result = createMantleAnthropicStreamFn()(model, context, {
    apiKey: "bedrock-bearer-token",
    ...options,
  });
  expect(result).toBe(resultStream);
  return firstStreamOptions(model, context);
}

function createReasoningModel(id: string, overrides: Partial<Model> = {}) {
  return createTestModel({
    id: `anthropic.${id}`,
    name: id,
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
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const streamOptions = captureStreamOptions(
      createTestModel(),
      withProviderAcceptanceObserver(
        {
          apiKey: "bedrock-bearer-token",
          onResponse,
          headers: { "X-Caller": "caller-header" },
        },
        acceptanceObserver,
      ),
    );
    const clientOptions = requireRecord(clientMock.mock.calls[0]?.[0], "client options");
    expect(clientOptions).toMatchObject({
      apiKey: null,
      authToken: "bedrock-bearer-token",
      baseURL: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      fetch: expect.any(Function),
    });
    expect(clientOptions.defaultHeaders).toEqual({
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      "X-Test": "model-header",
      "X-Caller": "caller-header",
    });
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
    ["claude-mythos-preview", "max", "high"],
    ["claude-mythos-preview", "minimal", "low"],
    ["claude-opus-5", "max", "max"],
    ["claude-sonnet-5", undefined, "high"],
    ["claude-sonnet-5", "off", "low"],
    ["claude-mythos-5", undefined, "high"],
  ] as const)("maps %s reasoning %s to %s", (id, reasoning, effort) => {
    const preview = id === "claude-mythos-preview";
    const mythos = id === "claude-mythos-5";
    const options = captureStreamOptions(createReasoningModel(id), {
      reasoning,
      temperature: 0.2,
      ...(mythos ? { maxTokens: 1_000 } : {}),
    });
    expect(options).toMatchObject({ thinkingEnabled: true, effort });
    if (!preview) {
      expect(options.maxTokens).toBe(mythos ? 1_000 : 128_000);
      expect(options).not.toHaveProperty("temperature");
    }
    if (mythos) {
      expect(options).not.toHaveProperty("thinkingBudgetTokens");
    }
  });

  it.each([
    {
      limit: 1500,
      reasoning: "low",
      request: {},
      expected: { maxTokens: 1500, thinkingEnabled: false },
    },
    {
      limit: 128_000,
      reasoning: "xhigh",
      request: { maxTokens: 2048, thinkingBudgets: { high: 4096, xhigh: 6144 } },
      expected: { maxTokens: 8192, thinkingEnabled: true, thinkingBudgetTokens: 6144 },
    },
  ] as const)(
    "adjusts legacy $reasoning thinking within $limit tokens",
    ({ limit, reasoning, request, expected }) => {
      const options = captureStreamOptions(
        createReasoningModel("claude-haiku-4-5", { maxTokens: limit }),
        { reasoning, ...request },
      );
      expect(options).toMatchObject(expected);
      if (!expected.thinkingEnabled) {
        expect(options).not.toHaveProperty("thinkingBudgetTokens");
      }
    },
  );
});
