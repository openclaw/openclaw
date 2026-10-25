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

function createTestModel(id = "claude-opus-4-7", overrides: Partial<Model> = {}): Model {
  return {
    id: `anthropic.${id}`,
    name: id,
    params: { canonicalModelId: id },
    provider: "amazon-bedrock-mantle",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    headers: { "X-Test": "model-header" },
    reasoning: id !== "claude-opus-4-7",
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

function captureStreamOptions(model: Model, options: SimpleStreamOptions = {}) {
  const client = {};
  clientMock.mockImplementation(function () {
    return client as never;
  });
  const resultStream = { kind: "anthropic-stream" };
  streamMock.mockReturnValue(resultStream as never);
  const result = createMantleAnthropicStreamFn()(
    model,
    { messages: [] },
    {
      apiKey: "bedrock-bearer-token",
      ...options,
    },
  );
  expect(result).toBe(resultStream);
  const forwarded = requireRecord(streamMock.mock.calls[0]?.[2], "stream options");
  expect(forwarded.client).toBe(client);
  return forwarded;
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
    expect(streamOptions).toMatchObject({ thinkingEnabled: false, onResponse });
    await notifyProviderStreamOpened({ options: streamOptions, cancelStream: vi.fn() });
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it.each([
    ["claude-mythos-preview", "max", "high", undefined],
    ["claude-mythos-preview", "minimal", "low", undefined],
    ["claude-opus-5", "max", "max", 128_000],
    ["claude-sonnet-5", undefined, "high", 128_000],
    ["claude-sonnet-5", "off", "low", 128_000],
    ["claude-mythos-5", undefined, "high", 1_000],
  ] as const)("maps %s reasoning %s to %s", (id, reasoning, effort, maxTokens) => {
    const options = captureStreamOptions(createTestModel(id), {
      reasoning,
      temperature: 0.2,
      ...(id === "claude-mythos-5" ? { maxTokens } : {}),
    });
    expect(options).toMatchObject({ thinkingEnabled: true, effort });
    if (maxTokens) {
      expect(options.maxTokens).toBe(maxTokens);
      expect(options).not.toHaveProperty("temperature");
    }
    expect(options).not.toHaveProperty("thinkingBudgetTokens");
  });

  it.each(["low", "xhigh"] as const)("adjusts legacy %s thinking", (reasoning) => {
    const enabled = reasoning === "xhigh";
    const options = captureStreamOptions(
      createTestModel("claude-haiku-4-5", { maxTokens: enabled ? 128_000 : 1500 }),
      {
        reasoning,
        ...(enabled ? { maxTokens: 2048, thinkingBudgets: { high: 4096, xhigh: 6144 } } : {}),
      },
    );
    expect(options).toMatchObject({ maxTokens: enabled ? 8192 : 1500, thinkingEnabled: enabled });
    if (enabled) {
      expect(options.thinkingBudgetTokens).toBe(6144);
    } else {
      expect(options).not.toHaveProperty("thinkingBudgetTokens");
    }
  });
});
