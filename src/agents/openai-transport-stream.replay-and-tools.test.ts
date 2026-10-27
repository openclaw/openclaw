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
  provider?: string;
  model?: string;
  stopReason?: "stop" | "toolUse";
  thinking?: {
    signature: string | Record<string, unknown>;
    replayMetadata?: unknown;
  };
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
      thinking: "Need a tool.",
      thinkingSignature:
        typeof spec.thinking.signature === "string"
          ? spec.thinking.signature
          : JSON.stringify(spec.thinking.signature),
      ...(spec.thinking.replayMetadata === undefined
        ? {}
        : { openclawReasoningReplay: spec.thinking.replayMetadata }),
    });
  }
  for (const toolCall of spec.toolCalls ?? []) {
    content.push({ type: "toolCall", ...toolCall });
  }
  const messages = [
    ...(spec.before ?? []),
    {
      role: "assistant",
      api: spec.source?.api ?? "openai-responses",
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

function responsesModelFixture(id = "gpt-5.5", name = id) {
  return makeResponsesModel({ id, name });
}

type ReplayItem = {
  type?: string;
  role?: string;
  id?: string;
  call_id?: string;
  phase?: string;
  status?: string;
  encrypted_content?: string;
  summary?: unknown;
  output?: unknown;
  arguments?: string;
};
type ReplayParams = { store?: boolean; input?: ReplayItem[] };

const session = { sessionId: "session-123" };
const proxyModel = makeResponsesModel({
  id: "gpt-5.4",
  api: "openai-chatgpt-responses",
  baseUrl: "https://proxy.example.com/v1",
});

function toolContext(id: string, name: string, content: readonly unknown[]) {
  return replayContext({
    toolCalls: [{ id, name, arguments: {} }],
    results: [{ id, name, content }],
  });
}

function recover(
  create: ReturnType<typeof vi.fn>,
  request: unknown,
  onCompactionRejected?: () => void,
) {
  return testing.createResponsesStreamWithRecovery({
    client: { responses: { create } } as never,
    request: request as never,
    buildFullHistoryRequest: () => request as never,
    requestOptions: undefined,
    model: responsesModelFixture(),
    onCompactionRejected,
  });
}

const encryptedError = () =>
  Object.assign(new Error("invalid encrypted content"), {
    code: "invalid_encrypted_content",
  });
const mixedRequest = () => ({
  model: "gpt-5.5",
  stream: true,
  input: [
    { type: "reasoning", encrypted_content: "reasoning", summary: [] },
    { type: "compaction", encrypted_content: "compaction" },
  ],
});
function rejectedResponse(error: Error) {
  return { withResponse: vi.fn().mockRejectedValue(error) };
}

function emptyResponsesContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

describe("openai transport stream", () => {
  it("keeps embedded replay provenance as a compatibility fallback", () => {
    const options = { ...session, authProfileId: "openai:oauth" };
    const params = buildOpenAIResponsesParams(
      proxyModel,
      replayContext({
        source: proxyModel,
        thinking: {
          signature: {
            type: "reasoning",
            id: "rs_prior",
            encrypted_content: "ciphertext",
            __openclaw_replay: testing.buildOpenAIResponsesReasoningReplayMetadata(
              proxyModel,
              options,
            ),
          },
        },
      }),
      options,
    ) as ReplayParams;
    const item = params.input?.find((entry) => entry.type === "reasoning");
    expectRecordFields(item, { type: "reasoning", encrypted_content: "ciphertext", summary: [] });
    expect(item?.id).toBeUndefined();
    expect(item).not.toHaveProperty("__openclaw_replay");
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
    ) as ReplayParams;

    expect(params.input?.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("strips encrypted content recursively while retaining unrelated nested fields", async () => {
    const original = mixedRequest();
    const request = {
      ...original,
      input: [
        {
          ...original.input[0],
          nested: { encrypted_content: "nested-ciphertext", keep: "value" },
        },
      ],
    };
    const create = vi
      .fn()
      .mockReturnValueOnce(rejectedResponse(encryptedError()))
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: streamChunks([]),
          response: new Response(null, { status: 200 }),
        }),
      });

    await recover(create, request);
    expect(create.mock.calls[1]?.[0].input).toEqual([
      {
        type: "reasoning",
        summary: [],
        nested: { keep: "value" },
      },
    ]);
  });

  it.each([
    { name: "final recovery failure", attempts: 3, error: new Error("final recovery failed") },
    {
      name: "unrelated reasoning-free failure",
      attempts: 2,
      error: new OpenAI.RateLimitError(
        429,
        { code: "rate_limit_exceeded", message: "rate limited", type: "rate_limit_error" },
        undefined,
        new Headers(),
      ),
    },
  ])("does not tombstone compaction or advance after $name", async ({ attempts, error }) => {
    const create = vi.fn().mockReturnValueOnce(rejectedResponse(encryptedError()));
    if (attempts === 3) {
      create.mockReturnValueOnce(rejectedResponse(encryptedError()));
    }
    create.mockReturnValueOnce(rejectedResponse(error));
    const onCompactionRejected = vi.fn();
    await expect(recover(create, mixedRequest(), onCompactionRejected)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(attempts);
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
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [{ type: "reasoning", encrypted_content: "reasoning", summary: [] }],
    } as never;
    const result = await recover(create, request);

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
      session,
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

  it("replays empty non-image tool results as no output", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture(),
      toolContext("call_plan", "update_plan", []),
      session,
    ) as ReplayParams;
    expectRecordFields(
      params.input?.find((item) => item.type === "function_call_output"),
      {
        type: "function_call_output",
        call_id: "call_plan",
        output: "(no output)",
      },
    );
  });

  it("normalizes canonical reasoning casing in Responses and Chat Completions payloads", () => {
    const context = emptyResponsesContext();
    const baseModel = { id: "gpt-5.5", name: "GPT-5.5" };
    const responses = buildOpenAIResponsesParams(makeResponsesModel(baseModel), context, {
      reasoningEffort: " XHIGH ",
    } as never) as { reasoning?: unknown };
    const completions = buildOpenAICompletionsParams(makeCompletionsModel(baseModel), context, {
      reasoningEffort: " XHIGH ",
    } as never) as { reasoning_effort?: unknown };

    expect(responses.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(completions.reasoning_effort).toBe("xhigh");
  });

  it.each([
    ["web_search", "low"],
    ["lookup_weather", "minimal"],
  ] as const)("uses %s to choose reasoning effort %s", (toolName, effort) => {
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
            name: toolName,
            description: "Fixture tool",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort, summary: "auto" });
  });

  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4"),
      replayContext({
        model: "gpt-5.4",
        stopReason: "stop",
        toolCalls: [{ id: "call_abc|fc_item1", name: "my_tool", arguments: "not valid json" }],
      }),
      undefined,
    ) as ReplayParams;

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      arguments: "not valid json",
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4"),
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
