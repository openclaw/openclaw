import OpenAI from "openai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { serializeModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  makeCompletionsModel,
  makeResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

type ReplayContextSpec = {
  results?: ReadonlyArray<{
    id: string;
    name: string;
    content: readonly unknown[];
  }>;
  before?: readonly unknown[];
  after?: readonly unknown[];
};

function replayContext(
  source: Pick<Model, "api" | "id" | "provider">,
  content: readonly unknown[],
  spec: ReplayContextSpec = {},
) {
  const messages = [
    ...(spec.before ?? []),
    {
      role: "assistant",
      api: source.api,
      provider: source.provider,
      model: source.id,
      usage: createZeroUsageFixture(),
      stopReason: "toolUse",
      timestamp: 1,
      content,
    },
    ...(spec.results ?? []).map(({ id, name, content: resultContent }) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: resultContent,
      isError: false,
      timestamp: 2,
    })),
    ...(spec.after ?? []),
  ];
  return { systemPrompt: "system", messages, tools: [] } as never;
}

type ReplayParams = {
  store?: boolean;
  input?: Array<
    Partial<
      Record<"type" | "role" | "id" | "call_id" | "phase" | "status" | "encrypted_content", string>
    > & { summary?: unknown }
  >;
};

function priceReplay(source: Model, replayMetadata?: unknown, withResult = false) {
  const id = "call_abc|fc_prior";
  return replayContext(
    source,
    [
      {
        type: "thinking",
        thinking: "Need a tool.",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
        }),
        ...(replayMetadata === undefined ? {} : { openclawReasoningReplay: replayMetadata }),
      },
      {
        type: "text",
        text: "Checking the price.",
        textSignature: JSON.stringify({ v: 1, id: "msg_prior", phase: "commentary" }),
      },
      { type: "toolCall", id, name: "price_lookup", arguments: { symbol: "SOL" } },
    ],
    {
      results: withResult
        ? [{ id, name: "price_lookup", content: [{ type: "text", text: "$83.95" }] }]
        : [],
    },
  );
}

function expectStorelessReplay(params: ReplayParams) {
  const assistantMessage = params.input?.find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expectRecordFields(assistantMessage, { type: "message", role: "assistant", phase: "commentary" });
  expect(assistantMessage?.id).toBeUndefined();
  const functionCall = params.input?.find((item) => item.type === "function_call");
  expectRecordFields(functionCall, { type: "function_call", call_id: "call_abc" });
  expect(functionCall?.id).toBeUndefined();
  return assistantMessage;
}

function emptyResponsesContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

describe("openai transport stream", () => {
  it("omits Responses replay item ids when OpenAI Responses requests disable store", () => {
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "mycodex",
      baseUrl: "http://127.0.0.1:8317/v1",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const request = buildOpenAIResponsesParams(model, priceReplay(model, undefined, true), {
      sessionId: "session-123",
    });
    const params = JSON.parse(
      new TextDecoder().decode(serializeModelRequestBody(request).body),
    ) as ReplayParams;

    expect(params.store).toBe(false);
    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
    const assistantMessage = expectStorelessReplay(params);
    expect(assistantMessage?.status).toBeUndefined();
  });

  it("preserves Responses replay item ids when a store-enabled wrapper requests replay", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      replayContext({
        model: "gpt-5.4",
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
        },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
        results: [
          {
            id: "call_abc|fc_prior",
            name: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
          },
        ],
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        status?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      id: "rs_prior",
      summary: [],
    });
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      id: "msg_prior",
      phase: "commentary",
      status: "completed",
    });
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      id: "fc_prior",
      call_id: "call_abc",
    });
  });

  it("omits prior Responses replay item ids when store is disabled for custom Codex-compatible responses", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      priceReplay(
        model,
        testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
          authProfileId: "openai:oauth",
          sessionId: "session-123",
        }),
      ),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as ReplayParams;

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("__openclaw_replay");
    expectStorelessReplay(params);
  });

  it("drops oversized GitHub Copilot Responses reasoning replay ids before send", () => {
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      contextWindow: 400000,
    });
    const longReasoningId = `rs_${"x".repeat(380)}`;

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: { signature: { type: "reasoning", id: longReasoningId, summary: [] } },
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
      }>;
    };

    expect(params.input?.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("keeps embedded replay provenance as a compatibility fallback", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: {
            type: "reasoning",
            id: "rs_prior",
            encrypted_content: "ciphertext",
            __openclaw_replay: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: "openai:oauth",
              sessionId: "session-123",
            }),
          },
        },
      }),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("__openclaw_replay");
  });

  it("retries mixed replay without reasoning first and preserves compaction on success", async () => {
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
          summary: [{ type: "summary_text", text: "checked" }],
          nested: { encrypted_content: "nested-ciphertext", keep: "value" },
        },
        {
          type: "compaction",
          id: "cmp_prior",
          encrypted_content: "compaction-ciphertext",
        },
        {
          type: "function_call",
          id: "fc_prior",
          call_id: "call_abc",
          name: "price_lookup",
          arguments: "{}",
        },
      ],
    };
    const recoveredStream = streamChunks([]);
    const recoveredResponse = new Response(null, { status: 200 });
    const create = vi
      .fn()
      .mockReturnValueOnce({
        withResponse: vi.fn().mockRejectedValue(
          Object.assign(new Error("invalid reasoning"), {
            code: "invalid_encrypted_content",
          }),
        ),
      })
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: recoveredStream,
          response: recoveredResponse,
        }),
      });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithRecovery({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).resolves.toMatchObject({
      stream: recoveredStream,
    });

    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1]?.[0] as typeof request;
    expect(retry.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "checked" }],
      nested: { keep: "value" },
    });
    expect(retry.input[0]).not.toHaveProperty("encrypted_content");
    expect(retry.input[0]?.nested).not.toHaveProperty("encrypted_content");
    expect(retry.input[1]).toEqual(request.input[1]);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not tombstone compaction when the final recovery attempt fails", async () => {
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const finalFailure = new Error("final recovery failed");
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(finalFailure) });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithRecovery({
        client: { responses: { create } } as never,
        request: {
          model: "gpt-5.5",
          stream: true,
          input: [
            { type: "reasoning", encrypted_content: "reasoning", summary: [] },
            { type: "compaction", encrypted_content: "compaction" },
          ],
        } as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).rejects.toBe(finalFailure);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not advance past an unrelated error from the reasoning-free attempt", async () => {
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const unrelatedFailure = new OpenAI.RateLimitError(
      429,
      { code: "rate_limit_exceeded", message: "rate limited", type: "rate_limit_error" },
      undefined,
      new Headers(),
    );
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(unrelatedFailure) });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithRecovery({
        client: { responses: { create } } as never,
        request: {
          model: "gpt-5.5",
          stream: true,
          input: [
            { type: "reasoning", encrypted_content: "reasoning", summary: [] },
            { type: "compaction", encrypted_content: "compaction" },
          ],
        } as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).rejects.toBe(unrelatedFailure);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not retry encrypted-content failures emitted after stream creation", async () => {
    const streamFailure = Object.assign(new Error("stream rejected encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const responseStream = (async function* () {
      yield { type: "response.created", response: { id: "resp_stream" } };
      throw streamFailure;
    })();
    const create = vi.fn().mockReturnValue({
      withResponse: vi.fn().mockResolvedValue({
        data: responseStream,
        response: new Response(null, { status: 200 }),
      }),
    });
    const result = await testing.createResponsesStreamWithRecovery({
      client: { responses: { create } } as never,
      request: {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "reasoning", encrypted_content: "reasoning", summary: [] }],
      } as never,
      requestOptions: undefined,
      model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
    });

    await expect(async () => {
      for await (const event of result.stream) {
        // Consume until the provider stream rejects.
        void event;
      }
    }).rejects.toBe(streamFailure);
    expect(create).toHaveBeenCalledOnce();
  });

  it("normalizes overlong Copilot Responses replay tool ids before dispatch", () => {
    const longToolItemId = "iVec" + "A".repeat(360);
    const longToolCallId = `call_ug6lFGKwZDjHfzW8H0PDQRwN|${longToolItemId}`;
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
    });
    const params = buildOpenAIResponsesParams(
      model,
      replayContext(
        model,
        [
          {
            type: "toolCall",
            id: longToolCallId,
            name: "exec",
            arguments: { command: "gh pr list --limit 1" },
          },
        ],
        {
          before: [{ role: "user", content: "read the queue", timestamp: 0 }],
          results: [{ id: longToolCallId, name: "exec", content: [{ type: "text", text: "[]" }] }],
          after: [{ role: "user", content: "continue", timestamp: 3 }],
        },
      ),
      { sessionId: "session-123" },
    ) as ReplayParams;

    const functionCall = params.input?.find((item) => item.type === "function_call");
    const functionOutput = params.input?.find((item) => item.type === "function_call_output");
    expect(functionCall).toBeDefined();
    expect(functionOutput).toBeDefined();
    expect(functionCall?.id).toBeUndefined();
    expect(functionCall?.call_id).toBe("call_ug6lFGKwZDjHfzW8H0PDQRwN");
    expect(functionOutput?.call_id).toBe(functionCall?.call_id);
    for (const item of params.input ?? []) {
      if (item.id !== undefined) {
        expect(item.id.length).toBeLessThanOrEqual(64);
      }
      if (item.call_id !== undefined) {
        expect(item.call_id.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it("replays update_plan-style empty non-image Responses tool results as no output", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      replayContext({
        toolCalls: [{ id: "call_plan", name: "update_plan", arguments: {} }],
        results: [{ id: "call_plan", name: "update_plan", content: [] }],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    expect(params.input?.find((item) => item.type === "function_call_output")).toMatchObject({
      type: "function_call_output",
      call_id: "call_plan",
      output: "(no output)",
    });
  });

  it("replays payload-less Responses tool images as no output without image parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        input: ["text", "image"],
      }),
      replayContext({
        toolCalls: [{ id: "call_husk", name: "screenshot", arguments: {} }],
        results: [
          {
            id: "call_husk",
            name: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
          },
        ],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    const output = params.input?.find((item) => item.type === "function_call_output");
    expect(output).toMatchObject({ call_id: "call_husk", output: "(no output)" });
    expect(JSON.stringify(output)).not.toContain("input_image");
    expect(JSON.stringify(output)).not.toContain("see attached image");
  });

  it("preserves image-bearing Responses tool results as image input parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        input: ["text", "image"],
      }),
      replayContext({
        toolCalls: [{ id: "call_shot", name: "screenshot", arguments: {} }],
        results: [
          {
            id: "call_shot",
            name: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
          },
        ],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; output?: unknown }>;
    };

    expect(params.input?.find((item) => item.type === "function_call_output")?.output).toEqual([
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,aW1n",
      },
    ]);
  });

  it("serializes structured tool result content (e.g. json blocks) into Responses function_call_output text", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      replayContext({
        toolCalls: [{ id: "call_lookup", name: "lookup", arguments: { query: "price" } }],
        results: [
          {
            id: "call_lookup",
            name: "lookup",
            content: [{ type: "json", payload: { price: 42, currency: "USD" } }],
          },
        ],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      undefined,
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    const output = params.input?.find((item) => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(output?.call_id).toBe("call_lookup");
    const outputText = output?.output as string;
    expect(typeof outputText).toBe("string");
    expect(outputText).toContain("price");
    expect(outputText).toContain("42");
    expect(outputText).not.toBe("(see attached image)");
  });

  it("normalizes canonical reasoning casing in Responses and Chat Completions payloads", () => {
    const context = emptyResponsesContext();
    const baseModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"] as Model["input"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };

    const responses = buildOpenAIResponsesParams(
      makeResponsesModel({
        ...baseModel,
      }),
      context,
      { reasoningEffort: " XHIGH " } as never,
    ) as { reasoning?: unknown };
    const completions = buildOpenAICompletionsParams(
      makeCompletionsModel({
        ...baseModel,
      }),
      context,
      { reasoningEffort: " XHIGH " } as never,
    ) as { reasoning_effort?: unknown };

    expect(responses.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(completions.reasoning_effort).toBe("xhigh");
  });

  it("raises minimal OpenAI Responses reasoning when web_search is available", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    });

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("keeps minimal OpenAI Responses reasoning without web_search", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    });

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });

  it("does not reread an unreadable tool inventory length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const responsesModel = makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" });
    const completionsModel = makeCompletionsModel({
      ...responsesModel,
      api: "openai-completions",
      reasoning: false,
    });
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools,
    } as never;

    expect(buildOpenAIResponsesParams(responsesModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
    expect(buildOpenAICompletionsParams(completionsModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
  });

  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "toolCall",
                id: "call_abc|fc_item1",
                name: "my_tool",
                arguments: "not valid json",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ type?: string; arguments?: string }>;
    };

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      arguments: "not valid json",
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]?.strict).toBe(false);
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    });
  });
});
