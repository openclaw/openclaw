import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type { evaluateDecisionInRegistry } from "../../../decisions/runtime.js";
import type { DecisionOutcome } from "../../../decisions/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { evaluateAttemptDecisionToolPrefilter } from "./attempt-decision-prefilter.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn<typeof evaluateDecisionInRegistry>() }));
vi.mock("../../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));

function config(optIn = true, model: string | undefined = "fixture/model"): OpenClawConfig {
  return {
    agents: {
      defaults: AgentDefaultsBaseSchema.parse({
        experimental: { decisionAssistance: optIn },
        decisionModel: model,
      }),
    },
  };
}
const answer = (probabilityTrue = 0.1): DecisionOutcome => ({
  status: "ok",
  provenance: { providerId: "fixture", rubricVersion: "7", runtimeGeneration: "test" },
  result: {
    model: "model",
    answers: {
      missing_request_context: { type: "boolean", probabilityTrue: 0.1 },
      next_response_needs_tools: { type: "boolean", probabilityTrue },
    },
  },
});
function params(cfg = config()) {
  return {
    config: cfg,
    agentId: "main",
    supportsTurnScopedToolRestrictions: true,
    assertActive: vi.fn(),
    userMessage: "Hello",
    messages: [
      { role: "user", content: "Can we chat?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Of course." }],
        api: "openai-responses",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ] satisfies AgentMessage[],
    signal: new AbortController().signal,
  };
}
beforeEach(() => {
  mocks.evaluate.mockReset().mockResolvedValue(answer());
});
afterEach(clearRuntimeConfigSnapshot);

describe("Decision tool prefilter admission", () => {
  it.each([
    [false, undefined],
    [false, "fixture/model"],
    [true, undefined],
  ] as const)("does not dispatch with opt-in %s and model %s", async (enabled, model) => {
    const cfg = config(enabled);
    cfg.agents!.defaults!.decisionModel = model;
    expect(await evaluateAttemptDecisionToolPrefilter(params(cfg))).toMatchObject({
      shouldPruneTools: false,
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each([false, undefined])(
    "does not dispatch without explicit harness support %s",
    async (support) => {
      expect(
        await evaluateAttemptDecisionToolPrefilter({
          ...params(),
          supportsTurnScopedToolRestrictions: support,
        }),
      ).toMatchObject({ shouldPruneTools: false });
      expect(mocks.evaluate).not.toHaveBeenCalled();
    },
  );
  it("preserves explicit empty agent override and requires the owning agent", async () => {
    const cfg = config();
    cfg.agents!.entries = { quiet: { decisionModel: "" } };
    for (const agentId of ["quiet", ""]) {
      expect(await evaluateAttemptDecisionToolPrefilter({ ...params(cfg), agentId })).toMatchObject(
        {
          shouldPruneTools: false,
        },
      );
    }
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("submits the actual Boolean rubric, trusted owner, signal and runtime deadline", async () => {
    const input = params();
    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate).toHaveBeenCalledWith(
      {
        state: {
          recentConversation: [{ user: "Can we chat?", assistant: "Of course." }],
          latestRequest: "Hello",
          omittedContext: { olderConversation: false, toolPayloads: false },
        },
        questions: {
          missing_request_context: {
            type: "boolean",
            instructions: expect.stringContaining("`latestRequest`"),
            criteria: {
              true: expect.stringContaining("exact prior-conversation content"),
              false: expect.any(String),
            },
          },
          next_response_needs_tools: {
            type: "boolean",
            instructions: expect.stringContaining("Resolve labels, numbers"),
            criteria: {
              true: expect.stringContaining("go with option A"),
              false: expect.any(String),
            },
          },
        },
      },
      {
        agentId: "main",
        purpose: "tool-prefilter.semantic-gate",
        rubricVersion: "9",
        timeoutMs: 500,
        signal: input.signal,
      },
      null,
      input.config,
    );
    expect(input.assertActive).toHaveBeenCalledTimes(2);
  });
  it("passes bounded prompt-build fields verbatim and structurally labeled", async () => {
    const promptBuildFields = {
      systemPrompt: "  replacement system  ",
      prependContext: "prefix\ncontext",
      appendContext: "suffix ",
      prependSystemContext: " system prefix ",
      appendSystemContext: "system suffix\n",
    };
    const input = { ...params(), promptBuildFields };

    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate.mock.calls[0]?.[0]).toMatchObject({
      state: { beforePromptBuild: promptBuildFields },
      questions: {
        missing_request_context: { instructions: expect.stringContaining("beforePromptBuild") },
        next_response_needs_tools: { instructions: expect.stringContaining("beforePromptBuild") },
      },
    });
  });

  it("retains the baseline tool surface instead of truncating oversized prompt-build fields", async () => {
    expect(
      await evaluateAttemptDecisionToolPrefilter({
        ...params(),
        messages: [],
        promptBuildFields: { appendContext: "x".repeat(8_000) },
      }),
    ).toMatchObject({
      shouldPruneTools: false,
      status: "skipped",
      reason: "prompt-build-context-too-large",
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ["ascii exact", "x".repeat(6_000), "h".repeat(2_000), true, undefined],
    [
      "combined overflow",
      "x".repeat(6_000),
      "h".repeat(2_001),
      false,
      "prompt-build-context-too-large",
    ],
    ["projection overflow", "x".repeat(6_001), "", false, "context-too-large"],
    ["astral exact", "🙂".repeat(3_000), "🙂".repeat(1_000), true, undefined],
    [
      "astral overflow",
      "🙂".repeat(3_000),
      "🙂".repeat(1_000) + "x",
      false,
      "prompt-build-context-too-large",
    ],
    ["JSON expansion", "x".repeat(6_000), String.fromCharCode(34).repeat(2_000), true, undefined],
  ] as const)(
    "enforces separate UTF-16 text bounds: %s",
    async (_label, request, hooks, admitted, reason) => {
      const promptBuildFields = {
        prependContext: hooks.slice(0, 1_000),
        appendSystemContext: hooks.slice(1_000),
      };
      const outcome = await evaluateAttemptDecisionToolPrefilter({
        ...params(),
        userMessage: request,
        messages: [],
        promptBuildFields,
      });
      expect(outcome.shouldPruneTools).toBe(admitted);
      if (!admitted) {
        expect(outcome.reason).toBe(reason);
        expect(mocks.evaluate).not.toHaveBeenCalled();
      } else {
        const batch = mocks.evaluate.mock.calls[0]?.[0];
        expect(batch?.state).toMatchObject({
          latestRequest: request,
          beforePromptBuild: promptBuildFields,
        });
        // The bounded strings are preserved, even when encoding/framing is larger.
        expect(JSON.stringify(batch?.state).length).toBeGreaterThan(request.length + hooks.length);
      }
    },
  );

  it.each([0.35, 0.9])("retains tools at probability %s", async (probability) => {
    mocks.evaluate.mockResolvedValue(answer(probability));
    expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
      shouldPruneTools: false,
    });
  });
  it.each(["deadline", "not-configured", "transport", "unsupported-input"] as const)(
    "skips ordinary %s unavailability",
    async (reason) => {
      mocks.evaluate.mockResolvedValue({ status: "unavailable", reason });
      expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
        shouldPruneTools: false,
      });
    },
  );
  it("never classifies a named explicit decision_evaluate request", async () => {
    expect(
      await evaluateAttemptDecisionToolPrefilter({
        ...params(),
        userMessage: "Use decision_evaluate on Hello",
      }),
    ).toMatchObject({ shouldPruneTools: false });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("rechecks published eligibility at final proposal acceptance", async () => {
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const proposal = await evaluateAttemptDecisionToolPrefilter(params(cfg));
    expect(proposal.isCurrent?.()).toBe(true);
    setRuntimeConfigSnapshot(config(false));
    expect(proposal.isCurrent?.()).toBe(false);
  });
  it("does not infer from an empty request", async () => {
    expect(
      await evaluateAttemptDecisionToolPrefilter({ ...params(), userMessage: "  " }),
    ).toMatchObject({
      shouldPruneTools: false,
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each(["opt-out", "model-change"])(
    "rejects stale pruning after %s publication",
    async (change) => {
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      mocks.evaluate.mockImplementation(async () => {
        setRuntimeConfigSnapshot(
          change === "opt-out" ? config(false) : config(true, "fixture/other"),
        );
        return answer();
      });
      expect(await evaluateAttemptDecisionToolPrefilter(params(cfg))).toMatchObject({
        shouldPruneTools: false,
      });
    },
  );
  it("preserves explicit prepared config scope independently of the global runtime", async () => {
    setRuntimeConfigSnapshot(config(false));
    const input = params();
    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate.mock.calls[0]?.[3]).toBe(input.config);
  });
  it("never dispatches after abort or closed authority", async () => {
    const input = params();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      evaluateAttemptDecisionToolPrefilter({ ...input, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    input.assertActive.mockImplementation(() => {
      throw new Error("closed");
    });
    await expect(evaluateAttemptDecisionToolPrefilter(input)).rejects.toThrow("closed");
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("preserves unexpected contract errors and late owner cancellation", async () => {
    mocks.evaluate.mockRejectedValueOnce(new Error("contract failure"));
    await expect(evaluateAttemptDecisionToolPrefilter(params())).rejects.toThrow(
      "contract failure",
    );
    const input = params();
    mocks.evaluate.mockImplementation(async () => {
      input.assertActive.mockImplementation(() => {
        throw new Error("closed");
      });
      return answer();
    });
    await expect(evaluateAttemptDecisionToolPrefilter(input)).rejects.toThrow("closed");
  });
  it("evaluates a complete fresh-session request with no invented history", async () => {
    const result = await evaluateAttemptDecisionToolPrefilter({ ...params(), messages: [] });
    expect(result).toMatchObject({ shouldPruneTools: true, status: "proposed" });
    expect(mocks.evaluate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        state: {
          recentConversation: [],
          latestRequest: "Hello",
          omittedContext: { olderConversation: false, toolPayloads: false },
        },
      }),
      expect.any(Object),
      null,
      expect.any(Object),
    );
  });
  it("does not reinterpret incomplete existing history as a fresh session", async () => {
    const result = await evaluateAttemptDecisionToolPrefilter({
      ...params(),
      messages: [{ role: "user", content: "Apply the patch", timestamp: 1 }],
    });
    expect(result).toMatchObject({
      shouldPruneTools: false,
      status: "skipped",
      reason: "missing-exchange",
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each([undefined, 0.35, 0.5, 0.9])(
    "retains tools when missing-context answer is %s",
    async (probabilityTrue) => {
      const value = answer();
      if (value.status !== "ok") {
        throw new Error("fixture");
      }
      const answers = { ...value.result.answers };
      if (probabilityTrue === undefined) {
        delete answers.missing_request_context;
      } else {
        answers.missing_request_context = { type: "boolean", probabilityTrue };
      }
      mocks.evaluate.mockResolvedValue({ ...value, result: { ...value.result, answers } });
      expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
        shouldPruneTools: false,
        reason: "missing-context-or-uncertain",
      });
      expect(mocks.evaluate).toHaveBeenCalledOnce();
    },
  );
  it("retains tools when the tool-need answer is missing", async () => {
    const value = answer();
    if (value.status !== "ok") {
      throw new Error("fixture");
    }
    const answers = { ...value.result.answers };
    delete answers.next_response_needs_tools;
    mocks.evaluate.mockResolvedValue({ ...value, result: { ...value.result, answers } });
    expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
      shouldPruneTools: false,
    });
  });
  it("sends omission facts without treating older omitted context as a veto", async () => {
    const input = params();
    input.messages.unshift(...input.messages, ...input.messages);
    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate.mock.calls[0]?.[0].state).toMatchObject({
      omittedContext: { olderConversation: true, toolPayloads: false },
    });
  });

  it.each(["missing_request_context", "next_response_needs_tools"])(
    "retains tools for a non-Boolean %s answer",
    async (id) => {
      const value = answer();
      if (value.status !== "ok") {
        throw new Error("fixture");
      }
      const answers = { ...value.result.answers };
      answers[id] = {
        type: "choice",
        choice: "no",
        probabilities: { yes: 0.1, no: 0.9 },
        confidence: 0.9,
      };
      mocks.evaluate.mockResolvedValue({ ...value, result: { ...value.result, answers } });
      expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
        shouldPruneTools: false,
      });
    },
  );
});
