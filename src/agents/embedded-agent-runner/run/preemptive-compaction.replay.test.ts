import {
  captureOpenAIResponsesCompaction,
  resolveCompactionReplayPressure,
} from "@openclaw/ai/transports";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import { preparedRequestSuffix } from "../../../../packages/ai/src/provider-options.js";
import { recordResponsesContextUsage } from "../../../../packages/ai/src/transports/openai-responses-context-usage.js";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { convertResponsesMessages } from "../../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { createOpenAIResponsesContextManagementWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import { testing } from "../../openai-transport-stream.test-support.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  estimateLlmBoundaryTokenPressure,
  resolveProjectedRequestPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 100_000,
  maxTokens: 8_192,
}) satisfies Model;
const identity = { sessionId: "session-a", authProfileId: "profile-a" };

function assistant(totalTokens: number): AssistantMessage {
  return makeAgentAssistantMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "covered assistant" }],
    timestamp: 2,
    usage: {
      ...createZeroUsageFixture(),
      input: totalTokens - 1,
      output: 1,
      totalTokens,
      contextUsage: { state: "available", promptTokens: totalTokens - 1, totalTokens },
    },
  });
}

function checkpoint(text: string): AssistantMessage {
  const owner = assistant(90_000);
  const item = { type: "compaction" as const, id: "cmp_pressure", encrypted_content: "opaque" };
  captureOpenAIResponsesCompaction(
    owner,
    item,
    "retained-users",
    model,
    testing.buildOpenAIResponsesReasoningReplayMetadata(model, identity),
    [{ type: "message", role: "user", content: [{ type: "input_text", text }] }, item],
  );
  return owner;
}

function pressure(messages: AgentMessage[]) {
  return estimateLlmBoundaryTokenPressure({
    messages,
    prompt: "new turn",
    replay: { model, ...identity },
  });
}

describe("provider checkpoint prompt pressure", () => {
  function measuredWindow(toolCall = false) {
    const owner = checkpoint("retained content ".repeat(8_000));
    const response = assistant(2_001);
    const text = {
      type: "text" as const,
      text: "done",
      textSignature: JSON.stringify({ v: 1, id: "msg_measured" }),
    };
    const call = {
      type: "toolCall" as const,
      id: "call_read|fc_read",
      name: "read",
      arguments: {},
    };
    response.content = [toolCall ? call : text];
    response.responseId = toolCall ? "resp_async" : "resp_measured";
    response.stopReason = toolCall ? "toolUse" : "stop";
    const request = {
      input: convertResponsesMessages(model, { messages: [owner] }, new Set(["openai"]), identity),
    };
    const output: Parameters<typeof recordResponsesContextUsage>[4] = toolCall
      ? [
          {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "{}",
          },
        ]
      : [
          {
            type: "message",
            id: "msg_measured",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          },
        ];
    recordResponsesContextUsage(response, model, identity, request, output, "transport");
    return { owner, response };
  }

  it("uses measured checkpoint usage after a saved transcript roundtrip and counts new input", () => {
    const { owner, response } = measuredWindow();
    const persisted = JSON.stringify([owner, response]);
    const messages = JSON.parse(persisted) as AgentMessage[];
    expect(pressure(messages)).toBeGreaterThanOrEqual(2_001);
    expect(pressure(messages)).toBeLessThan(2_100);
    const legacy = resolveCompactionReplayPressure([owner, response], model, identity, {
      text: (value) => value.length / 4,
      json: (value) => JSON.stringify(value).length / 4,
      image: () => 1_024,
    });
    // Existing package callers must not lose the measured portion of the prefix.
    expect(legacy?.prefixTokens).toBeGreaterThanOrEqual(2_001);
    expect(legacy?.prefixTokens).toBeLessThan(3_000);
    expect(
      pressure([...messages, { role: "user", content: "new tail ".repeat(2_000), timestamp: 5 }]),
    ).toBeGreaterThan(5_000);
  });

  it.each(["checkpoint", "response", "usage", "route"])(
    "does not borrow measured usage after the %s changes",
    (change) => {
      const { owner, response } = measuredWindow();
      if (change === "checkpoint") {
        const next = checkpoint("different retained content ".repeat(8_000));
        owner.providerReplay = next.providerReplay;
      } else if (change === "response") {
        response.content = [{ type: "text", text: "changed response" }];
      } else if (change === "usage") {
        response.usage.contextUsage = { state: "available", promptTokens: 1, totalTokens: 2 };
      } else {
        response.model = "different-model";
      }
      expect(pressure([owner, response])).toBeGreaterThan(20_000);
    },
  );

  it("reserves current tool definitions beyond the measured conversation", () => {
    const { owner, response } = measuredWindow();
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [owner, response],
      prompt: "new turn",
      contextTokenBudget: 10_000,
      reserveTokens: 0,
      toolSchemaTokens: 12_000,
      replay: { model, ...identity },
    });
    expect(decision.compactionReplay?.route).toBe("compact_only");
  });

  it("counts tool results persisted before the terminal usage event as new context", () => {
    const { owner, response } = measuredWindow(true);
    const fragment = {
      ...response,
      usage: { ...response.usage, input: 0, output: 0, totalTokens: 0, contextUsage: undefined },
    };
    const messages: AgentMessage[] = [
      owner,
      fragment,
      {
        role: "toolResult",
        toolCallId: "call_read|fc_read",
        toolName: "read",
        content: [{ type: "text", text: "new observation ".repeat(200) }],
        isError: false,
        timestamp: 3,
      },
      { ...response, content: [] },
    ];
    const covered = messages.filter((message) => message.role !== "toolResult");
    // The 3,200-character observation adds its content beyond the measured prefix.
    expect(pressure(messages)).toBeGreaterThan(pressure(covered) + 800);
    expect(pressure(messages)).toBeLessThan(6_000);
  });
});

const BIG_OUTPUT = "build log line ".repeat(90000);

describe("Responses admission conversion handoff", () => {
  const host = getAiTransportHost();
  const wireGolden =
    '{"model":"gpt-5.6-luna","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"retained"}]},{"type":"compaction","id":"cmp_pressure","encrypted_content":"opaque"},{"id":"rs_summary","type":"reasoning","summary":[]},{"id":"rs_read","type":"reasoning","summary":[],"encrypted_content":"synthetic-reasoning"},{"type":"function_call","id":"fc_read","call_id":"call_read","name":"read","arguments":"{\\"path\\":\\"sample.txt\\"}"},{"type":"function_call_output","call_id":"call_read","output":[{"type":"input_text","text":"sample output"},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,aW1hZ2U="}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"red basket"}]}],"stream":true,"prompt_cache_key":"session-a","instructions":"Synthetic instructions","max_output_tokens":8192,"reasoning":{"effort":"none"},"store":true,"context_management":[{"type":"compaction","compact_threshold":70000}]}';
  afterEach(() => configureAiTransportHost(host));

  function requestFixture() {
    const owner = checkpoint("retained");
    const response = assistant(2_001);
    const reasoning = {
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_read",
        summary: [],
        encrypted_content: "synthetic-reasoning",
      }),
      openclawReasoningReplay: testing.buildOpenAIResponsesReasoningReplayMetadata(model, identity),
    };
    response.content = [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_summary", summary: [] }),
      },
      reasoning,
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "sample.txt" },
      },
    ];
    response.stopReason = "toolUse";
    recordResponsesContextUsage(
      response,
      model,
      identity,
      {
        input: convertResponsesMessages(
          model,
          { messages: [owner] },
          new Set(["openai"]),
          identity,
        ),
      },
      [
        { type: "reasoning", id: "rs_summary", summary: [] },
        { type: "reasoning", id: "rs_read", summary: [], encrypted_content: "synthetic-reasoning" },
        {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          name: "read",
          arguments: '{"path":"sample.txt"}',
        },
      ],
      "transport",
    );
    const context: Context = {
      systemPrompt: "Synthetic instructions",
      messages: [
        owner,
        response,
        {
          role: "toolResult",
          toolCallId: "call_read|fc_read",
          toolName: "read",
          content: [
            { type: "text", text: "sample output" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          timestamp: 3,
          isError: false,
        },
        { role: "user", content: "red basket", timestamp: 4 },
      ],
    };
    const convert = vi.fn(host.transformTransportMessages);
    configureAiTransportHost({ ...host, transformTransportMessages: convert });
    return { context, convert };
  }

  const admit = (context: Context) =>
    resolveProjectedRequestPressure({
      context,
      contextTokenBudget: 100_000,
      reserveTokens: 0,
      replay: { model, ...identity },
    });

  async function build(context: Context, variant?: "stateless" | "text-transform" | "hook") {
    let request: ReturnType<typeof buildOpenAIResponsesParams> | undefined;
    const stream: StreamFn = async (requestModel, requestContext, options) => {
      request = buildOpenAIResponsesParams(requestModel, requestContext, {
        ...options,
        ...identity,
        ...(variant === "stateless" ? { replayResponsesItemIds: false } : {}),
      });
      await options?.onPayload?.(request, requestModel);
      return createQueuedAssistantStream(() => {});
    };
    const wrapped = createOpenAIResponsesContextManagementWrapper(stream, undefined);
    const send =
      variant === "text-transform"
        ? wrapStreamFnTextTransforms({
            streamFn: wrapped,
            input: [{ from: "red basket", to: "blue basket" }],
            transformSystemPrompt: false,
          })
        : wrapped;
    await send(model, context, {
      ...identity,
      ...(variant === "hook"
        ? {
            onPayload: (payload: unknown) => {
              const input = (payload as { input: Array<{ content?: Array<{ text?: string }> }> })
                .input;
              input[0]!.content![0]!.text = "hook replacement";
            },
          }
        : {}),
    });
    if (!request) {
      throw new Error("Provider wrapper did not build a request");
    }
    return request;
  }

  it("converts admission and the managed request once without changing wire bytes or pressure", async () => {
    const { context, convert } = requestFixture();
    const decision = admit(context);
    const request = await build(context);
    expect(decision).toMatchObject({
      route: "fits",
      pressureSource: "provider_context_usage",
      estimatedPromptTokens: 4_530,
    });
    expect(JSON.stringify(request)).toBe(wireGolden);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it.each(["stateless", "text-transform"] as const)(
    "keeps %s wire conversion distinct from the original accounting projection",
    async (variant) => {
      const { context, convert } = requestFixture();
      const decision = admit(context);
      const request = await build(context, variant);
      expect(decision.estimatedPromptTokens).toBe(4_530);
      expect(convert).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(request)).toBe(
        variant === "stateless"
          ? wireGolden
              .replace('{"id":"rs_summary","type":"reasoning","summary":[]},', "")
              .replace('"id":"rs_read",', "")
              .replace('"id":"fc_read",', "")
          : wireGolden.replace("red basket", "blue basket"),
      );
    },
  );

  it("consumes preparation once and isolates mutable hooks from replay and follow-up input", async () => {
    const { context, convert } = requestFixture();
    admit(context);
    expect(JSON.stringify(await build(context, "hook"))).toBe(
      wireGolden.replace("retained", "hook replacement"),
    );
    context.messages[3] = { role: "user", content: "next mutable turn", timestamp: 5 };
    const request = await build(context);
    expect(JSON.stringify(request)).toBe(wireGolden.replace("red basket", "next mutable turn"));
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("preserves captured-prefix tool IDs when the request owns a prepared suffix", async () => {
    const { context, convert } = requestFixture();
    context.messages.push({
      role: "toolResult",
      toolCallId: "call_pending___",
      toolName: "read",
      content: [{ type: "text", text: "late result" }],
      timestamp: 5,
      isError: false,
    });
    preparedRequestSuffix.mark(context, new Set(["call_pending"]));
    expect(admit(context).pressureSource).toBe("provider_context_usage");
    expect(JSON.stringify(await build(context))).toBe(
      wireGolden.replace(
        '],"stream":true',
        ',{"type":"function_call_output","call_id":"call_pending","output":"late result"}],"stream":true',
      ),
    );
    expect(convert).toHaveBeenCalledTimes(2);
  });
});

function bashExecMessage(output = BIG_OUTPUT): AgentMessage {
  return {
    role: "bashExecution",
    command: "npm run build",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  } as unknown as AgentMessage;
}

function customMessage(display: boolean, excludeFromContext = false): AgentMessage {
  return {
    role: "custom",
    customType: display ? "display-note" : "openclaw-runtime-context",
    content: BIG_OUTPUT,
    display,
    excludeFromContext,
    timestamp: 1,
  };
}

function providerTokenApprox(message: AgentMessage): number {
  const [llm] = convertToLlm([message]);
  const content = llm?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");

  return Math.ceil(text.length / 4);
}

describe("preemptive precheck counts bashExecution and summary turns", () => {
  it.each([
    { message: bashExecMessage(), minimum: 50000 },
    {
      message: {
        role: "compactionSummary",
        summary: "recap ".repeat(20000),
        tokensBefore: 0,
        timestamp: 1,
      } satisfies AgentMessage,
      minimum: 20000,
    },
  ])("counts $message.role near its provider-rendered size", ({ message, minimum }) => {
    const realProviderTokens = providerTokenApprox(message);
    const precheckTokens = estimateLlmBoundaryTokenPressure({ messages: [message], prompt: "" });
    expect(realProviderTokens).toBeGreaterThan(minimum);
    expect(precheckTokens).toBeGreaterThanOrEqual(realProviderTokens);
  });

  it.each([
    {
      role: "bashExecution",
      message: { ...bashExecMessage(), excludeFromContext: true } as AgentMessage,
    },
    {
      role: "custom",
      message: customMessage(true, true),
    },
  ])("drops excluded $role turns from token pressure", ({ message }) => {
    expect(estimateLlmBoundaryTokenPressure({ messages: [message], prompt: "" })).toBeLessThan(50);
    expect(
      shouldPreemptivelyCompactBeforePrompt({
        messages: [message],
        prompt: "continue",
        contextTokenBudget: 128000,
        reserveTokens: 16384,
      }).route,
    ).toBe("fits");
  });

  it("counts undisplayed custom context when it remains model-visible", () => {
    const runtimeContext = customMessage(false);
    expect(
      estimateLlmBoundaryTokenPressure({ messages: [runtimeContext], prompt: "" }),
    ).toBeGreaterThan(50000);
  });
});
