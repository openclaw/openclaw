import type { Context } from "@openclaw/llm-core";
import OpenAI from "openai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
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
  thinking?: Record<string, unknown>;
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: unknown }>;
  results?: ReadonlyArray<{
    id: string;
    name: string;
    content: readonly unknown[];
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
      thinkingSignature: JSON.stringify(spec.thinking),
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
      provider: spec.source?.provider ?? "openai",
      model: spec.source?.id ?? "gpt-5.5",
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

const responsesModelFixture = (id = "gpt-5.5") => makeResponsesModel({ id, name: id });

type ReplayItem = {
  type?: string;
  id?: string;
  call_id?: string;
};
type ReplayParams = { store?: boolean; input?: ReplayItem[] };

const copilotModel = makeResponsesModel({
  id: "gpt-5.5",
  provider: "github-copilot",
  baseUrl: "https://api.githubcopilot.com",
});
const session = { sessionId: "session-123" };
const proxyModel = makeResponsesModel({
  id: "gpt-5.4",
  api: "openai-chatgpt-responses",
  baseUrl: "https://proxy.example.com/v1",
});

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
const rejectedResponse = (error: Error) => ({ withResponse: vi.fn().mockRejectedValue(error) });

describe("openai transport stream", () => {
  it("reuses frozen history across turns without changing bytes or sharing hook edits", () => {
    const model = responsesModelFixture();
    const context: Context = replayContext({
      before: [{ role: "user", timestamp: 0, content: [{ type: "text", text: "question" }] }],
      toolCalls: [{ id: "call_1|fc_1", name: "lookup", arguments: "not valid json" }],
      results: [{ id: "call_1|fc_1", name: "lookup", content: [{ type: "text", text: "result" }] }],
    });
    context.messages.forEach(freezeJsonSnapshot);
    const first = buildOpenAIResponsesParams(model, context, undefined);
    const bytes = JSON.stringify(first);
    for (let turn = 0; turn < 4; turn++) {
      const next = buildOpenAIResponsesParams(model, context, undefined);
      expect(JSON.stringify(next)).toBe(bytes);
      next.input?.forEach((item, index) => expect(item).toBe(first.input?.[index]));
    }
    const hooked = buildOpenAIResponsesParams(model, context, { onPayload: () => undefined });
    const call = hooked.input?.find((item) => item.type === "function_call");
    if (!call || call.type !== "function_call") {
      throw new Error("fixture must contain a function call");
    }
    expect(call.arguments).toBe("not valid json");
    call.arguments = "edited by hook";
    expect(JSON.stringify(buildOpenAIResponsesParams(model, context, undefined))).toBe(bytes);
    context.messages.push({ role: "user", timestamp: 3, content: "next turn" });
    const extended = buildOpenAIResponsesParams(model, context, undefined);
    first.input?.forEach((item, index) => expect(extended.input?.[index]).toBe(item));
    for (const shallow of [false, true]) {
      const block = { type: "text" as const, text: "before" };
      const message = { role: "user" as const, timestamp: 0, content: [block] };
      if (shallow) {
        Object.freeze(message.content);
        Object.freeze(message);
      }
      const mutableInput = () =>
        buildOpenAIResponsesParams(model, { messages: [message] }, undefined);
      expect(JSON.stringify(mutableInput())).toContain("before");
      block.text = "after";
      expect(JSON.stringify(mutableInput())).toContain("after");
    }
  });

  it("keeps embedded replay provenance as a compatibility fallback", () => {
    const options = { ...session, authProfileId: "openai:oauth" };
    const params = buildOpenAIResponsesParams(
      proxyModel,
      replayContext({
        source: proxyModel,
        thinking: {
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
          __openclaw_replay: testing.buildOpenAIResponsesReasoningReplayMetadata(
            proxyModel,
            options,
          ),
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
    const model = { ...copilotModel, contextWindow: 400000 };
    const longReasoningId = `rs_${"x".repeat(380)}`;

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: { type: "reasoning", id: longReasoningId, summary: [] },
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
      copilotModel,
      replayContext({
        source: copilotModel,
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
      replayContext({
        toolCalls: [{ id: "call_plan", name: "update_plan", arguments: {} }],
        results: [{ id: "call_plan", name: "update_plan", content: [] }],
      }),
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
    const context = { systemPrompt: "system", messages: [], tools: [] };
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
