import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import { testing } from "../../openai-transport-stream.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  estimateLlmBoundaryTokenPressure,
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
  it("anchors on provider-measured usage after the checkpoint without a saved wire binding", () => {
    // Production shape: WebSocket replay, steering and retries record usage but no binding.
    const owner = checkpoint("retained content ".repeat(8_000));
    const measured = pressure([owner, assistant(2_001)]);
    expect(measured).toBeGreaterThanOrEqual(2_001);
    expect(measured).toBeLessThan(2_100);
    // The owner's usage predates its own compaction and never anchors the window.
    const unmeasured = pressure([owner]);
    expect(unmeasured).toBeGreaterThan(20_000);
    expect(unmeasured).toBeLessThan(90_000);
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
