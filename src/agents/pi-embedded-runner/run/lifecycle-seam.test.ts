import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_RUN_LIFECYCLE_DECISION_MODES,
  EMBEDDED_RUN_LIFECYCLE_DECISION_NEXT_VALUES,
  EMBEDDED_RUN_LIFECYCLE_SURFACE,
  EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION,
  buildEmbeddedRunLifecycleReceipt,
  createEmbeddedRunLifecycleBaseEvent,
  resolveEmbeddedRunPassTransitionDecision,
} from "./lifecycle-seam.js";

describe("embedded run lifecycle seam", () => {
  it("builds a stable B1 lifecycle base event envelope", () => {
    expect(
      createEmbeddedRunLifecycleBaseEvent({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "key-1",
        agentId: "main",
        provider: "openai",
        modelId: "gpt-5.4",
        passIndex: 1,
        passKind: "model_call",
        correlationId: "corr-1",
      }),
    ).toEqual({
      runtimeSurface: EMBEDDED_RUN_LIFECYCLE_SURFACE,
      lifecycleSeamVersion: EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION,
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "key-1",
      agentId: "main",
      provider: "openai",
      modelId: "gpt-5.4",
      passIndex: 1,
      passKind: "model_call",
      correlationId: "corr-1",
    });
  });

  it("builds a stable lifecycle receipt envelope", () => {
    expect(
      buildEmbeddedRunLifecycleReceipt({
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 2,
            passKind: "model_call",
            correlationId: "corr-2",
          }),
          event: "pass_transition_decision",
          source: "prompt",
          proposedAction: "surface_error",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
        outcome: "noop",
        reason: "rate_limit",
        annotations: { lane: "observe_only" },
      }),
    ).toEqual({
      runtimeSurface: EMBEDDED_RUN_LIFECYCLE_SURFACE,
      lifecycleSeamVersion: EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION,
      event: "pass_transition_decision",
      passIndex: 2,
      passKind: "model_call",
      correlationId: "corr-2",
      envelopeOnly: true,
      decisionEffective: false,
      outcome: "noop",
      reason: "rate_limit",
      annotations: { lane: "observe_only" },
    });
  });

  it("allows live-effective decision receipts to declare non-envelope execution", () => {
    expect(
      buildEmbeddedRunLifecycleReceipt({
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 3,
            passKind: "model_call",
            correlationId: "corr-3",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "continue",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
        outcome: "observed",
        reason: "operator_override",
        annotations: { lane: "live", retriesGranted: 1 },
        envelopeOnly: false,
        decisionEffective: true,
      }),
    ).toEqual({
      runtimeSurface: EMBEDDED_RUN_LIFECYCLE_SURFACE,
      lifecycleSeamVersion: EMBEDDED_RUN_LIFECYCLE_SEAM_VERSION,
      event: "pass_transition_decision",
      passIndex: 3,
      passKind: "model_call",
      correlationId: "corr-3",
      envelopeOnly: false,
      decisionEffective: true,
      outcome: "observed",
      reason: "operator_override",
      annotations: { lane: "live", retriesGranted: 1 },
    });
  });

  it("defaults transition decisions to noop when no seam is installed", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "prompt",
          proposedAction: "surface_error",
          proposedReason: null,
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).resolves.toEqual({ next: "noop" });
  });

  it("rejects unsupported decision modes even when no seam decision is returned", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        decisionMode: "ship_it" as never,
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "prompt",
          proposedAction: "surface_error",
          proposedReason: null,
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).rejects.toThrow(/unsupported decision mode/i);
  });

  it("freezes decision mode and next enums", () => {
    expect(EMBEDDED_RUN_LIFECYCLE_DECISION_MODES).toEqual(["observe_only", "decide"]);
    expect(EMBEDDED_RUN_LIFECYCLE_DECISION_NEXT_VALUES).toEqual(["noop", "continue", "halt"]);
  });

  it("rejects malformed decision payloads", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        seam: {
          onPassTransitionDecision: async () => ({ next: 123 }) as unknown as { next: "noop" },
        },
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "halt",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).resolves.toEqual({ next: "noop", unsupportedCapabilities: ["invalid_next:123"] });
  });

  it("keeps non-noop decisions fail-closed in observe_only mode", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        seam: {
          onPassTransitionDecision: async () => ({
            next: "continue",
            unsupportedCapabilities: ["decide"],
          }),
        },
        decisionMode: "observe_only",
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "continue",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).rejects.toThrow(/decision mode is observe_only/i);
  });

  it("allows halt decisions through in decide mode", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        seam: {
          onPassTransitionDecision: async () => ({
            next: "halt",
            reason: "operator_requested",
          }),
        },
        decisionMode: "decide",
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "halt",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).resolves.toEqual({ next: "halt", reason: "operator_requested" });
  });

  it("allows continue decisions through in decide mode", async () => {
    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        seam: {
          onPassTransitionDecision: async () => ({
            next: "continue",
            reason: "retry_allowed",
          }),
        },
        decisionMode: "decide",
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "continue",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).resolves.toEqual({ next: "continue", reason: "retry_allowed" });
  });

  it("fails closed when scaffold-only mode receives a non-noop decision", async () => {
    const onPassTransitionDecision = vi.fn(async () => ({ next: "halt" as const }));

    await expect(
      resolveEmbeddedRunPassTransitionDecision({
        seam: { onPassTransitionDecision },
        event: {
          ...createEmbeddedRunLifecycleBaseEvent({
            runId: "run-1",
            sessionId: "session-1",
            provider: "openai",
            modelId: "gpt-5.4",
            passIndex: 1,
            passKind: "model_call",
            correlationId: "corr-1",
          }),
          event: "pass_transition_decision",
          source: "assistant",
          proposedAction: "halt",
          proposedReason: "rate_limit",
          envelopeOnly: true,
          decisionEffective: false,
        },
      }),
    ).rejects.toThrow(/decision mode is observe_only/i);
  });
});
