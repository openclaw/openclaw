import {
  captureOpenAIResponsesCompaction,
  resolveCompactionReplayPressure,
} from "@openclaw/ai/transports";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import { recordResponsesContextUsage } from "../../../../packages/ai/src/transports/openai-responses-context-usage.js";
import { convertResponsesMessages } from "../../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { testing } from "../../openai-transport-stream.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  estimateLlmBoundaryTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
} satisfies Model;
const identity = { sessionId: "session-a", authProfileId: "profile-a" };

function assistant(totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "covered assistant" }],
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: totalTokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      contextUsage: { state: "available", promptTokens: totalTokens - 1, totalTokens },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
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
    expect(pressure(messages)).toBeGreaterThan(3_500);
    expect(pressure(messages)).toBeLessThan(6_000);
  });
});

const BIG_OUTPUT = "build log line ".repeat(90000);

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
