import type { Context, Model } from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: Record<string, unknown>) {
      sdkState.clients.push(options);
    }

    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { resolveOpenAIResponsesCompactEndpointPlan } from "./openai-responses-payload-policy.js";
import {
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "./openai-responses-transport.js";

const model = {
  id: "grok-4.5",
  name: "Grok 4.5",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

const officialOpenAIModel = {
  ...model,
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} satisfies Model<"openai-responses">;

const context = {
  systemPrompt: "Retain the conversation.",
  messages: [{ role: "user", content: "Remember NORTH-COPPER-17.", timestamp: 1 }],
} satisfies Context;

function mockCompactResponse(body: unknown): void {
  sdkState.post.mockResolvedValue(body);
}

function compact(requestModel: Model = model) {
  return requestPreparedOpenAIResponsesCompaction(
    createOpenAIResponsesTransportStreamFn(),
    requestModel,
    context,
    { apiKey: "test-key" },
  );
}

describe("responses compact endpoint", () => {
  beforeEach(() => {
    sdkState.clients.length = 0;
    sdkState.post.mockReset();
  });

  it("sends the system prompt as instructions and accepts retained users from official OpenAI", async () => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember NORTH-COPPER-17." }],
        },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 },
    });

    const result = await requestPreparedOpenAIResponsesCompaction(
      createOpenAIResponsesTransportStreamFn(),
      officialOpenAIModel,
      context,
      { apiKey: "test-key", sessionId: "session-1" },
    );

    expect(sdkState.clients[0]).toMatchObject({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
    });
    // The prompt stays out of input, so the endpoint cannot retain it in the window.
    expect(sdkState.post).toHaveBeenCalledWith(
      "/responses/compact",
      expect.objectContaining({
        body: {
          model: "gpt-5.6-luna",
          instructions: "Retain the conversation.",
          input: [expect.objectContaining({ role: "user", type: "message" })],
        },
      }),
    );
    expect(result).toMatchObject({
      output: [
        expect.objectContaining({ role: "user" }),
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      historyMode: "retained-users",
      usage: { input_tokens: 8_614, output_tokens: 736, dropped_message_count: 3 },
      model: officialOpenAIModel,
      replayMetadata: {
        source: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    });
  });

  it("rejects retained-message prefixes from native xAI", async () => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember NORTH-COPPER-17." }],
        },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await expect(compact()).rejects.toThrow("one trailing compaction item");
    // xAI has no instructions field on /responses/compact and disables the developer role.
    expect(sdkState.post).toHaveBeenCalledWith(
      "/responses/compact",
      expect.objectContaining({
        body: {
          model: "grok-4.5",
          input: [
            expect.objectContaining({ role: "system", type: "message" }),
            expect.objectContaining({ role: "user", type: "message" }),
          ],
        },
      }),
    );
  });

  it.each([
    { type: "input_image", detail: "auto" },
    { type: "input_file", file_id: 42 },
    { type: "output_text", text: "not supported input" },
  ])("rejects unsupported retained content without rewriting it: %j", async (block) => {
    mockCompactResponse({
      object: "response.compaction",
      output: [
        { type: "message", role: "user", content: [block] },
        { type: "compaction", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(compact(officialOpenAIModel)).rejects.toThrow("one trailing compaction item");
  });

  it.each([{ ...model, provider: "custom", baseUrl: "https://responses.example/v1" }])(
    "rejects endpoint output altered by the $provider route's status policy",
    async (route) => {
      mockCompactResponse({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "opaque", status: "completed" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await expect(compact(route)).rejects.toThrow("one trailing compaction item");
    },
  );

  it.each(["data:image/png;base64,invalid", "data:image/png;base64,/9j/"])(
    "rejects canonical image output that the transport would change: %s",
    async (imageUrl) => {
      mockCompactResponse({
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", detail: "auto", image_url: imageUrl }],
          },
          { type: "compaction", encrypted_content: "opaque" },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await expect(compact(officialOpenAIModel)).rejects.toThrow("one trailing compaction item");
    },
  );

  it.each([
    ["native xAI alias default", { ...model, provider: "x-ai" }, undefined, true],
    ["public OpenAI default", officialOpenAIModel, undefined, true],
    ["public OpenAI opt-out", officialOpenAIModel, { responsesCompactEndpoint: false }, false],
    [
      "custom Responses opt-in",
      { ...model, provider: "custom", baseUrl: "https://responses.example/v1" },
      { responsesCompactEndpoint: true },
      true,
    ],
    [
      "OpenAI without a resolved endpoint",
      { ...officialOpenAIModel, baseUrl: undefined },
      undefined,
      false,
    ],
    [
      "ChatGPT default",
      {
        ...officialOpenAIModel,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      undefined,
      false,
    ],
    [
      "Azure default",
      {
        ...officialOpenAIModel,
        provider: "azure-openai",
        baseUrl: "https://example.openai.azure.com",
      },
      undefined,
      false,
    ],
  ] as const)("resolves the %s gate", (_name, route, extraParams, enabled) => {
    expect(resolveOpenAIResponsesCompactEndpointPlan(route, extraParams).enabled).toBe(enabled);
  });
});
