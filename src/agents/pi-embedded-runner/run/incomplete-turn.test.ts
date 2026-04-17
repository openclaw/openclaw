/**
 * PR-8 follow-up tests for the plan-mode-acknowledge-only retry detector.
 *
 * Detector spec: when the session is in plan mode and the agent's response
 * had no exit_plan_mode tool call AND no genuine investigative tool call
 * AND the stop was clean (no abort/timeout/error), inject a corrective
 * steer for the next attempt. Hard-cap at 2 retries with escalating tone.
 *
 * The detector is meant to catch the action-selection drift Eva self-
 * diagnosed across multiple test rounds: "conversational reflex winning
 * over plan-mode workflow at the moment of action selection."
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
  resolvePlanModeAckOnlyRetryInstruction,
} from "./incomplete-turn.js";

type AttemptOverrides = Partial<
  Parameters<typeof resolvePlanModeAckOnlyRetryInstruction>[0]["attempt"]
>;

function makeAttempt(overrides: AttemptOverrides = {}) {
  return {
    assistantTexts: ["Got it, opening a fresh plan cycle."],
    clientToolCall: undefined,
    yieldDetected: false,
    didSendDeterministicApprovalPrompt: false,
    didSendViaMessagingTool: false,
    lastToolError: undefined,
    lastAssistant: { stopReason: "stop" } as Parameters<
      typeof resolvePlanModeAckOnlyRetryInstruction
    >[0]["attempt"]["lastAssistant"],
    toolMetas: [] as Array<{ toolName: string; meta?: string }>,
    replayMetadata: { hadPotentialSideEffects: false, replayInvalid: false },
    ...overrides,
  } as Parameters<typeof resolvePlanModeAckOnlyRetryInstruction>[0]["attempt"];
}

describe("resolvePlanModeAckOnlyRetryInstruction", () => {
  it("plan mode + ack-only text + no tool calls → returns standard instruction", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
      retryAttemptIndex: 0,
    });
    expect(result).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION);
  });

  it("plan mode + ack-only + retryAttemptIndex=1 → returns firm instruction", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
      retryAttemptIndex: 1,
    });
    expect(result).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM);
  });

  it("plan mode + has exit_plan_mode in toolMetas → returns null", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "exit_plan_mode" }],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + has read tool call → returns null (investigation phase)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "read" }],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + only update_plan tool call → returns instruction (update_plan is tracking, not submission)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "update_plan" }],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION);
  });

  it("plan mode + only enter_plan_mode call → returns instruction (enter_plan_mode does not satisfy submit)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "enter_plan_mode" }],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION);
  });

  it("plan mode + clientToolCall present → returns null (UI step already drove)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        clientToolCall: { name: "preview", params: {} },
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("not plan mode (planModeActive=false) → returns null", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: false,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + aborted=true → returns null", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: true,
      timedOut: false,
      attempt: makeAttempt(),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + timedOut=true → returns null", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: true,
      attempt: makeAttempt(),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + lastAssistant.stopReason='error' → returns null (fire only on clean stop)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        lastAssistant: { stopReason: "error" } as Parameters<
          typeof resolvePlanModeAckOnlyRetryInstruction
        >[0]["attempt"]["lastAssistant"],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + empty assistantTexts → returns null (empty-response handler owns this)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ assistantTexts: [] }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + replayMetadata.hadPotentialSideEffects=true → returns null (mutation already happened)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        replayMetadata: { hadPotentialSideEffects: true, replayInvalid: false },
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + assistantTexts > 1500 chars → returns null (likely wrote plan inline; out of scope)", () => {
    const longText = "a".repeat(1600);
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ assistantTexts: [longText] }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + non-plan tool call (write) → returns null (agent is acting, mutation gate handles policy)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "write" }],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });

  it("plan mode + lastToolError present → returns null (let error path own retry)", () => {
    const result = resolvePlanModeAckOnlyRetryInstruction({
      planModeActive: true,
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        lastToolError: { toolName: "read", error: "boom" } as Parameters<
          typeof resolvePlanModeAckOnlyRetryInstruction
        >[0]["attempt"]["lastToolError"],
      }),
      retryAttemptIndex: 0,
    });
    expect(result).toBeNull();
  });
});
