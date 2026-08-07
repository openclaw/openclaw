// Covers bridging provider_fallback assistant-message diagnostics to
// lifecycle fallback_step events (Anthropic server-side Fable 5 -> Opus 4.8).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitProviderFallbackLifecycleSteps } from "./embedded-agent-subscribe.provider-fallback-notice.js";

const { emitAgentEventMock } = vi.hoisted(() => ({
  emitAgentEventMock: vi.fn(),
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: emitAgentEventMock,
}));

function createContext(
  overrides?: Partial<{ sessionKey: string; agentId: string }>,
) {
  return {
    params: {
      runId: "run-1",
      sessionKey: overrides?.sessionKey ?? "agent:main:main",
      sessionId: "session-1",
      ...(overrides?.agentId ? { agentId: overrides.agentId } : {}),
    },
  };
}

function providerFallbackMessage(details: Record<string, unknown>) {
  return {
    role: "assistant",
    model: "claude-fable-5",
    diagnostics: [
      { type: "provider_fallback", timestamp: Date.now(), details },
    ],
  };
}

describe("emitProviderFallbackLifecycleSteps", () => {
  beforeEach(() => {
    emitAgentEventMock.mockClear();
  });

  it("emits a lifecycle fallback_step event for a provider_fallback diagnostic", () => {
    const emitted = emitProviderFallbackLifecycleSteps(
      createContext(),
      providerFallbackMessage({
        provider: "anthropic",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      }),
    );

    expect(emitted).toBe(1);
    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepType: "fallback_step",
        fallbackStepSource: "provider_server_side",
        fallbackStepFromModel: "anthropic/claude-fable-5",
        fallbackStepToModel: "anthropic/claude-opus-4-8",
        fallbackStepFromFailureDetail:
          "provider safety classifier declined the request; the provider served the response on its fallback model",
        fallbackStepFinalOutcome: "succeeded",
      },
    });
  });

  it("falls back to the message model when the boundary omits fromModel", () => {
    const emitted = emitProviderFallbackLifecycleSteps(
      createContext(),
      providerFallbackMessage({
        provider: "anthropic",
        fromModel: null,
        toModel: "claude-opus-4-8",
      }),
    );

    expect(emitted).toBe(1);
    const data = emitAgentEventMock.mock.calls[0]?.[0]?.data;
    expect(data?.fallbackStepFromModel).toBe("anthropic/claude-fable-5");
    expect(data?.fallbackStepToModel).toBe("anthropic/claude-opus-4-8");
  });

  it("omits fromModel when neither the boundary nor the message name one", () => {
    const emitted = emitProviderFallbackLifecycleSteps(
      { params: { runId: "run-1" } },
      {
        diagnostics: [
          {
            type: "provider_fallback",
            timestamp: Date.now(),
            details: {
              provider: "anthropic",
              fromModel: null,
              toModel: "claude-opus-4-8",
            },
          },
        ],
      },
    );

    expect(emitted).toBe(1);
    const data = emitAgentEventMock.mock.calls[0]?.[0]?.data;
    expect(data).not.toHaveProperty("fallbackStepFromModel");
    expect(data?.fallbackStepToModel).toBe("anthropic/claude-opus-4-8");
  });

  it("does not emit without a provider_fallback diagnostic", () => {
    expect(
      emitProviderFallbackLifecycleSteps(createContext(), {
        model: "claude-fable-5",
        diagnostics: [{ type: "other_diagnostic", timestamp: Date.now() }],
      }),
    ).toBe(0);
    expect(
      emitProviderFallbackLifecycleSteps(createContext(), {
        model: "claude-fable-5",
      }),
    ).toBe(0);
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("does not emit when the diagnostic lacks a serving model", () => {
    const emitted = emitProviderFallbackLifecycleSteps(
      createContext(),
      providerFallbackMessage({
        provider: "anthropic",
        fromModel: "claude-fable-5",
        toModel: null,
      }),
    );

    expect(emitted).toBe(0);
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("does not emit when the diagnostic lacks a provider", () => {
    const emitted = emitProviderFallbackLifecycleSteps(
      createContext(),
      providerFallbackMessage({
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      }),
    );

    expect(emitted).toBe(0);
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });
});
