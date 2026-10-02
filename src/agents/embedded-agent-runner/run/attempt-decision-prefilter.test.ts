import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type { evaluateDecisionInRegistry } from "../../../decisions/runtime.js";
import type { DecisionOutcome } from "../../../decisions/types.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { evaluateAttemptDecisionToolPrefilter } from "./attempt-decision-prefilter.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn<typeof evaluateDecisionInRegistry>() }));
vi.mock("../../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));
const config: OpenClawConfig = {
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      experimental: { decisionAssistance: true },
      decisionModel: "fixture/model",
    }),
  },
};
const answer = (): Extract<DecisionOutcome, { status: "ok" }> => ({
  status: "ok",
  provenance: { providerId: "fixture", rubricVersion: "9", runtimeGeneration: "test" },
  result: {
    model: "model",
    answers: {
      missing_request_context: { type: "boolean", probabilityTrue: 0.1 },
      next_response_needs_tools: { type: "boolean", probabilityTrue: 0.1 },
    },
  },
});
function params() {
  return {
    config,
    agentId: "main",
    supportsTurnScopedToolRestrictions: true,
    assertActive: vi.fn(),
    userMessage: "Hello",
    messages: [],
    signal: new AbortController().signal,
  };
}
beforeEach(() => {
  mocks.evaluate.mockReset().mockResolvedValue(answer());
});
afterEach(clearRuntimeConfigSnapshot);

describe("Decision prefilter policy", () => {
  it("forwards one atomic Boolean batch, labeled hook fields, owner and 500ms budget", async () => {
    const promptBuildFields = {
      systemPrompt: "  replacement system  ",
      prependContext: "prefix\ncontext",
      appendContext: "suffix ",
      prependSystemContext: " system prefix ",
      appendSystemContext: "system suffix\n",
    };
    const messages = Array.from({ length: 3 }, (_, index) => [
      { role: "user" as const, content: String(index), timestamp: index },
      makeAssistantMessageFixture({
        content: [{ type: "text", text: String(index) }],
        stopReason: "stop",
      }),
    ]).flat();
    const input = { ...params(), promptBuildFields, messages };
    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    const [batch, options, registry, selectedConfig] = mocks.evaluate.mock.calls[0]!;
    expect(batch.state).toEqual({
      recentConversation: [
        { user: "1", assistant: "1" },
        { user: "2", assistant: "2" },
      ],
      latestRequest: "Hello",
      beforePromptBuild: promptBuildFields,
      omittedContext: { olderConversation: true, toolPayloads: false },
    });
    expect(Object.keys(batch.questions)).toEqual([
      "missing_request_context",
      "next_response_needs_tools",
    ]);
    expect(options).toEqual({
      agentId: "main",
      purpose: "tool-prefilter.semantic-gate",
      rubricVersion: "9",
      timeoutMs: 500,
      signal: input.signal,
    });
    expect(registry).toBeNull();
    expect(selectedConfig).toBe(config);
    for (const question of Object.values(batch.questions)) {
      expect(question.type).toBe("boolean");
      for (const field of ["latestRequest", "recentConversation", "beforePromptBuild"]) {
        expect(question.instructions).toContain(field);
      }
    }
  });

  it.each([
    ["ASCII exact", "x".repeat(6_000), "h".repeat(2_000), undefined],
    ["combined overflow", "x".repeat(6_000), "h".repeat(2_001), "prompt-build-context-too-large"],
    ["projection overflow", "x".repeat(6_001), "", "context-too-large"],
    ["astral exact", "🙂".repeat(3_000), "🙂".repeat(1_000), undefined],
    ["astral overflow", "🙂".repeat(3_000), "🙂".repeat(1_001), "prompt-build-context-too-large"],
    ["JSON expansion", "x".repeat(6_000), String.fromCharCode(34).repeat(2_000), undefined],
  ] as const)(
    "bounds UTF-16 text, not JSON encoding: %s",
    async (_label, userMessage, hooks, reason) => {
      const promptBuildFields = {
        prependContext: hooks.slice(0, 1_000),
        appendSystemContext: hooks.slice(1_000),
      };
      const outcome = await evaluateAttemptDecisionToolPrefilter({
        ...params(),
        userMessage,
        promptBuildFields,
      });
      expect(outcome.shouldPruneTools).toBe(reason === undefined);
      if (reason) {
        expect(outcome.reason).toBe(reason);
        expect(mocks.evaluate).not.toHaveBeenCalled();
      } else {
        expect(mocks.evaluate.mock.calls[0]?.[0].state).toMatchObject({
          latestRequest: userMessage,
          beforePromptBuild: promptBuildFields,
        });
      }
    },
  );

  it.each(["missing_request_context", "next_response_needs_tools"])(
    "requires a strong Boolean no for %s",
    async (id) => {
      for (const value of [
        undefined,
        { type: "choice" as const, choice: "no", probabilities: { no: 1 }, confidence: 1 },
        ...[0.349, 0.35, 0.9].map((probabilityTrue) => ({
          type: "boolean" as const,
          probabilityTrue,
        })),
      ]) {
        const outcome = answer();
        const answers = { ...outcome.result.answers };
        if (value) {
          answers[id] = value;
        } else {
          delete answers[id];
        }
        mocks.evaluate.mockResolvedValue({ ...outcome, result: { ...outcome.result, answers } });
        expect((await evaluateAttemptDecisionToolPrefilter(params())).shouldPruneTools).toBe(
          value?.type === "boolean" && value.probabilityTrue < 0.35,
        );
      }
    },
  );
  it.each(["deadline", "not-configured", "transport", "unsupported-input"] as const)(
    "retains tools without retry on %s",
    async (reason) => {
      mocks.evaluate.mockResolvedValue({ status: "unavailable", reason });
      expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
        shouldPruneTools: false,
      });
      expect(mocks.evaluate).toHaveBeenCalledOnce();
    },
  );
  it.each(["", "Use decision_evaluate on Hello"])("does not classify %j", async (userMessage) => {
    expect(await evaluateAttemptDecisionToolPrefilter({ ...params(), userMessage })).toMatchObject({
      shouldPruneTools: false,
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("preserves explicit prepared config scope independently of the global runtime", async () => {
    setRuntimeConfigSnapshot({});
    expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate.mock.calls[0]?.[3]).toBe(config);
  });
  it("propagates unexpected contract errors", async () => {
    mocks.evaluate.mockRejectedValue(new Error("contract failure"));
    await expect(evaluateAttemptDecisionToolPrefilter(params())).rejects.toThrow(
      "contract failure",
    );
  });
});
