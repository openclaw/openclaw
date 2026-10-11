import OpenAI from "openai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
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
  source?: Pick<Model, "api" | "id" | "provider">;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: "stop" | "toolUse";
  thinking?: {
    signature: string | Record<string, unknown>;
    replayMetadata?: unknown;
    text?: string;
  };
  text?: true | { id: string; phase: "commentary" | "final_answer"; text: string };
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: unknown }>;
  results?: ReadonlyArray<{
    id: string;
    name: string;
    content: readonly unknown[];
    timestamp?: number;
  }>;
  before?: readonly unknown[];
  after?: readonly unknown[];
};

function replayContext(spec: ReplayContextSpec) {
  const content: Array<Record<string, unknown>> = [];
  if (spec.thinking) {
    content.push({
      type: "thinking",
      thinking: spec.thinking.text ?? "Need a tool.",
      thinkingSignature:
        typeof spec.thinking.signature === "string"
          ? spec.thinking.signature
          : JSON.stringify(spec.thinking.signature),
      ...(spec.thinking.replayMetadata === undefined
        ? {}
        : { openclawReasoningReplay: spec.thinking.replayMetadata }),
    });
  }
  if (spec.text) {
    const text =
      spec.text === true
        ? { id: "msg_prior", phase: "commentary" as const, text: "Checking the price." }
        : spec.text;
    content.push({
      type: "text",
      text: text.text,
      textSignature: JSON.stringify({ v: 1, id: text.id, phase: text.phase }),
    });
  }
  for (const toolCall of spec.toolCalls ?? []) {
    content.push({ type: "toolCall", ...toolCall });
  }
  const messages = [
    ...(spec.before ?? []),
    {
      role: "assistant",
      api: spec.source?.api ?? spec.api ?? "openai-responses",
      provider: spec.source?.provider ?? spec.provider ?? "openai",
      model: spec.source?.id ?? spec.model ?? "gpt-5.5",
      usage: createZeroUsageFixture(),
      stopReason: spec.stopReason ?? "toolUse",
      timestamp: 1,
      content,
    },
    ...(spec.results ?? []).map(({ id, name, content: resultContent, timestamp = 2 }) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: resultContent,
      isError: false,
      timestamp,
    })),
    ...(spec.after ?? []),
  ];
  return { systemPrompt: "system", messages, tools: [] } as never;
}

function responsesModelFixture(id: string, name: string) {
  return makeResponsesModel({ id, name });
}

describe("openai transport stream", () => {
  it("omits Responses replay item ids when OpenAI Responses requests disable store", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "mycodex",
        baseUrl: "http://127.0.0.1:8317/v1",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      replayContext({
        provider: "mycodex",
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
      { sessionId: "session-123" },
    ) as {
      store?: boolean;
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

    expect(params.store).toBe(false);
    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    expect(assistantMessage?.status).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
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
      replayContext({
        source: model,
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
          replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
            authProfileId: "openai:oauth",
            sessionId: "session-123",
          }),
        },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
      }),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
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
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
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

  it("normalizes overlong Copilot Responses replay tool ids before dispatch", () => {
    const longToolItemId = "iVec" + "A".repeat(360);
    const longToolCallId = `call_ug6lFGKwZDjHfzW8H0PDQRwN|${longToolItemId}`;
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
      }),
      replayContext({
        provider: "github-copilot",
        before: [{ role: "user", content: "read the queue", timestamp: 0 }],
        toolCalls: [
          {
            id: longToolCallId,
            name: "exec",
            arguments: { command: "gh pr list --limit 1" },
          },
        ],
        results: [{ id: longToolCallId, name: "exec", content: [{ type: "text", text: "[]" }] }],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; id?: string; call_id?: string }>;
    };

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

  it("does not reread an unreadable tool inventory length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const responsesModel = responsesModelFixture("gpt-5.5", "GPT-5.5");
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
});
