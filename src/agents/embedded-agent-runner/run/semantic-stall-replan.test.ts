import { describe, expect, it, vi } from "vitest";
import type { DecisionRuntimeV1 } from "../../../decisions/types.js";
import {
  createSemanticNoProgressObserver,
  type SemanticNoProgressObserver,
} from "../../semantic-no-progress.js";
import {
  createSemanticStallReplanState,
  maybeInjectSemanticStallReplan,
  type SemanticStallReplanState,
} from "./semantic-stall-replan.js";

const EXPECTED_REPLAN_INSTRUCTION =
  "The recent tool trajectory is strongly stalled. Reassess the active task and take one materially different, safe next step; do not repeat the stalled action.";

const context = {
  systemPrompt: "base system prompt",
  messages: [],
  tools: [],
};

type Judgment = NonNullable<ReturnType<SemanticNoProgressObserver["snapshot"]>["latestJudgment"]>;

function observerFor(
  judgment: Partial<Judgment>,
  trajectoryVersion: number,
): SemanticNoProgressObserver {
  return {
    observeOutcome: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    snapshot: vi.fn((): ReturnType<SemanticNoProgressObserver["snapshot"]> => ({
      latestJudgment: {
        verdict: "stalled",
        evidence: { detector: "generic_repeat", level: "warning", count: 10 },
        trajectorySize: 4,
        trajectoryVersion,
        ...judgment,
      },
      trajectoryVersion,
      metrics: {
        observedOutcomes: 1,
        decisionCalls: 1,
        unavailableDecisions: 0,
        invalidDecisions: 0,
        staleDecisions: 0,
        skippedWhilePending: 0,
        candidateFollowOnCalls: 0,
        verdicts: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
      },
    })),
  };
}

function stateFor(
  judgment: Partial<Judgment>,
  trajectoryVersion: number,
  assertActive = vi.fn(),
): SemanticStallReplanState {
  return {
    observer: observerFor(judgment, trajectoryVersion),
    assertActive,
    used: false,
  };
}

describe("semantic stall replan boundary", () => {
  it.each(["off", "shadow"] as const)(
    "does not promote an observer in %s mode into replan",
    (mode) => {
      const observer = observerFor({ probability: 1 }, 1);
      expect(
        createSemanticStallReplanState({ observer, mode, assertActive: vi.fn() }),
      ).toBeUndefined();
    },
  );

  it("injects one fixed system instruction for a current strong stalled judgment", () => {
    const messages = [...context.messages];
    const state = stateFor(
      {
        verdict: "stalled",
        probability: 0.95,
        evidence: { detector: "generic_repeat", level: "warning", count: 10 },
        trajectorySize: 4,
        trajectoryVersion: 1,
        toolCallOrdinal: 4,
      },
      1,
    );
    const update = maybeInjectSemanticStallReplan(
      { context: { ...context, messages } },
      state,
      new AbortController().signal,
    );

    expect(update?.context?.systemPrompt).toBe(
      `${context.systemPrompt}\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
    );
    expect(update?.context?.messages).toBe(messages);
    expect(state.used).toBe(true);
    expect(state.assertActive).toHaveBeenCalledOnce();

    const second = maybeInjectSemanticStallReplan(undefined, state, new AbortController().signal, {
      context: update!.context!,
      message: {} as never,
      toolResults: [],
      newMessages: [],
    });
    expect(second?.context?.systemPrompt).toBe(context.systemPrompt);
    expect(state.assertActive).toHaveBeenCalledOnce();
  });

  it.each([
    ["weak", 0.94, 1, 1],
    ["invalid", Number.NaN, 1, 1],
    ["stale", 0.99, 2, 1],
  ])("does not inject for %s semantic evidence", (_name, probability, version, current) => {
    const state = stateFor(
      {
        verdict: "stalled",
        probability,
        evidence: { detector: "generic_repeat", level: "warning", count: 10 },
        trajectorySize: 4,
        trajectoryVersion: version,
      },
      current,
    );
    const update = { context };

    expect(maybeInjectSemanticStallReplan(update, state, new AbortController().signal)).toBe(
      update,
    );
    expect(state.used).toBe(false);
    expect(state.assertActive).not.toHaveBeenCalled();
  });

  it("does not consume the opportunity when an existing owner stops the turn", () => {
    const state = stateFor({ verdict: "stalled", probability: 1, trajectoryVersion: 1 }, 1);
    const update = { context, stop: true };
    expect(maybeInjectSemanticStallReplan(update, state)).toBe(update);
    expect(state.used).toBe(false);
  });

  it("does not overwrite a newer prompt when retiring the one-turn instruction", () => {
    const state = stateFor({ verdict: "stalled", probability: 1, trajectoryVersion: 1 }, 1);
    maybeInjectSemanticStallReplan({ context }, state);
    const update = { context: { ...context, systemPrompt: "new owner prompt" } };
    expect(maybeInjectSemanticStallReplan(update, state)).toBe(update);
  });

  it("rechecks owner cancellation before consuming the budget", () => {
    const state = stateFor(
      {
        verdict: "stalled",
        probability: 1,
        evidence: { detector: "generic_repeat", level: "critical", count: 20 },
        trajectorySize: 4,
        trajectoryVersion: 1,
      },
      1,
      vi.fn(() => {
        throw new Error("run closed");
      }),
    );

    expect(() =>
      maybeInjectSemanticStallReplan({ context }, state, new AbortController().signal),
    ).toThrow("run closed");
    expect(state.used).toBe(false);
  });

  it("does not consume the budget when the caller is already canceled", () => {
    const state = stateFor({ verdict: "stalled", probability: 1, trajectoryVersion: 1 }, 1);
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));

    expect(() => maybeInjectSemanticStallReplan({ context }, state, controller.signal)).toThrow(
      "caller stopped",
    );
    expect(state.used).toBe(false);
  });

  it.each([
    [
      "typed unavailable",
      vi.fn(async () => ({ status: "unavailable" as const, reason: "transport" as const })),
    ],
    [
      "provider throw",
      vi.fn(async () => {
        throw new Error("provider failed");
      }),
    ],
  ])("keeps %s non-authoritative and leaves the replan budget unused", async (_label, evaluate) => {
    const observer = createSemanticNoProgressObserver({
      signal: new AbortController().signal,
      assertActive: vi.fn(),
      runtime: { evaluate } satisfies DecisionRuntimeV1,
    });
    const state = createSemanticStallReplanState({
      observer,
      mode: "replan",
      assertActive: vi.fn(),
    });
    if (!state) {
      throw new Error("replan state missing");
    }
    await observer.observeOutcome({
      toolName: "read",
      toolParams: { path: "/synthetic/repeated" },
      result: "unchanged",
      toolCallOrdinal: 11,
      evidence: { detector: "generic_repeat", level: "warning", count: 10 },
    });

    const update = { context };
    expect(maybeInjectSemanticStallReplan(update, state)).toBe(update);
    expect(observer.snapshot().latestJudgment?.verdict).toBe("uncertain");
    expect(state.used).toBe(false);
    await observer.close();
  });
});
