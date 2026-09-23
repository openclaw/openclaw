import {
  captureOpenAIResponsesCompaction,
  resolveCompactionReplayPressure,
} from "@openclaw/ai/transports";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
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
  function measuredWindow() {
    const owner = checkpoint("retained content ".repeat(8_000));
    const response = assistant(2_001);
    response.content = [
      { type: "text", text: "done", textSignature: JSON.stringify({ v: 1, id: "msg_measured" }) },
    ];
    response.responseId = "resp_measured";
    const request = {
      input: convertResponsesMessages(model, { messages: [owner] }, new Set(["openai"]), identity),
    };
    recordResponsesContextUsage(
      response,
      model,
      identity,
      request,
      [
        {
          type: "message",
          id: "msg_measured",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      "transport",
    );
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
    const owner = checkpoint("retained content ".repeat(8_000));
    const response = assistant(2_001);
    response.responseId = "resp_async";
    response.stopReason = "toolUse";
    response.content = [{ type: "toolCall", id: "call_read|fc_read", name: "read", arguments: {} }];
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
        {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          name: "read",
          arguments: "{}",
        },
      ],
      "transport",
    );
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

  it("counts the canonical window once instead of covered text or stale owner usage", () => {
    const owner = checkpoint("small canonical window");
    const tail: AgentMessage[] = [{ role: "user", content: "follow-up", timestamp: 3 }];
    const canonicalPressure = pressure([owner, ...tail]);
    const withCoveredRaw = pressure([
      { role: "user", content: "covered raw text ".repeat(20_000), timestamp: 1 },
      owner,
      ...tail,
    ]);
    expect(canonicalPressure).toBeLessThan(1_000);
    expect(withCoveredRaw).toBe(canonicalPressure);
    expect(pressure([checkpoint("retained content ".repeat(8_000)), ...tail])).toBeGreaterThan(
      20_000,
    );
  });

  it("counts the window once without attributing unbound later usage to its prefix", () => {
    const owner = checkpoint("retained content ".repeat(8_000));
    const response = assistant(100);
    response.timestamp = 4;
    const tail: AgentMessage[] = [{ role: "user", content: "follow-up", timestamp: 3 }, response];
    const measuredPressure = pressure([owner, ...tail]);
    expect(measuredPressure).toBeGreaterThan(20_000);
    delete response.usage.contextUsage;
    expect(pressure([owner, ...tail])).toBe(measuredPressure);
  });
});
