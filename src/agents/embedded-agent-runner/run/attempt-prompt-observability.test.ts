import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

const hoisted = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  hasHooks: vi.fn(() => true),
  log: { debug: vi.fn(), info: vi.fn(), isEnabled: vi.fn(() => false), warn: vi.fn() },
  recordStage: vi.fn(),
  recordTrajectoryEvent: vi.fn(),
  runLlmInput: vi.fn<NonNullable<PromptObservabilityInput["hookRunner"]>["runLlmInput"]>(
    async () => {},
  ),
  toTrajectoryToolDefinitions: vi.fn((tools: ReadonlyArray<{ name?: string }>) =>
    tools.map((tool) => ({ name: tool.name })),
  ),
}));

vi.mock("../../../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: hoisted.emitTrustedDiagnosticEvent,
}));
vi.mock("../../../trajectory/runtime.js", () => ({
  toTrajectoryToolDefinitions: hoisted.toTrajectoryToolDefinitions,
}));
vi.mock("../logger.js", () => ({ log: hoisted.log }));

import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-support.js";

type PromptObservabilityInput = Parameters<typeof observeEmbeddedAttemptPrompt>[0];

function observe(overrides: Partial<PromptObservabilityInput> = {}, skipped = false) {
  const sessionMessages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "history" }], timestamp: 1 },
  ];
  const input: PromptObservabilityInput = {
    attempt: {
      messageChannel: "discord",
      modelId: "model-1",
      provider: "provider-1",
      runId: "run-1",
      senderId: "sender-1",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    },
    cacheTrace: { recordStage: hoisted.recordStage },
    contextTokenBudget: 32_000,
    diagnosticTrace: { traceId: "1".repeat(32), spanId: "2".repeat(16) },
    effectivePrompt: "effective prompt",
    effectiveTools: [{ name: "visible-tool" }],
    hookAgentId: "main",
    hookMessagesForCurrentPrompt: sessionMessages,
    hookRunner: { hasHooks: hoisted.hasHooks, runLlmInput: hoisted.runLlmInput },
    imageCount: 2,
    isRawModelRun: false,
    llmBoundaryPromptForPrecheck: "[boundary] model prompt",
    promptForModel: "model prompt",
    reserveTokens: 4_096,
    runTrace: { traceId: "1".repeat(32), spanId: "3".repeat(16) },
    sessionMessages,
    skipPromptSubmission: false,
    streamStrategy: "provider-stream",
    systemPromptForHook: "system prompt",
    toolSearchCompacted: true,
    tools: [{ name: "hook-tool" }],
    trajectoryRecorder: { recordEvent: hoisted.recordTrajectoryEvent },
    transcriptLeafId: "leaf-1",
    transport: "sse",
    uncompactedEffectiveTools: [{ name: "visible-tool" }, { name: "deferred-tool" }],
    ...overrides,
  };
  expect(observeEmbeddedAttemptPrompt(input)).toEqual({ skipPromptSubmission: skipped });
  return input;
}

describe("observeEmbeddedAttemptPrompt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the assembled prompt boundary and dispatches a cloned llm_input snapshot", () => {
    const input = observe();
    expect(hoisted.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "context.assembled",
        contextTokenBudget: 32_000,
        reserveTokens: 4_096,
      }),
    );
    const [event, context] = hoisted.runLlmInput.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      prompt: "[boundary] model prompt",
      imagesCount: 2,
      tools: [{ name: "hook-tool" }],
    });
    expect(event?.historyMessages).toEqual(input.hookMessagesForCurrentPrompt);
    expect(event?.historyMessages).not.toBe(input.hookMessagesForCurrentPrompt);
    expect(context).toMatchObject({ agentId: "main", channel: "discord", senderId: "sender-1" });
    expect(hoisted.recordTrajectoryEvent).toHaveBeenNthCalledWith(
      1,
      "context.compiled",
      expect.any(Object),
    );
  });

  it("keeps an already-blocked prompt out of cache, trajectory, and hook dispatch", () => {
    observe({ skipPromptSubmission: true }, true);
    expect(hoisted.recordStage).not.toHaveBeenCalled();
    expect(hoisted.recordTrajectoryEvent).not.toHaveBeenCalled();
    expect(hoisted.runLlmInput).not.toHaveBeenCalled();
  });

  it("ignores unrecorded tool metadata", () => {
    const tool = {
      get name(): string {
        throw new Error("unrecorded tool metadata must not be read");
      },
    };
    observe({
      effectiveTools: [tool],
      uncompactedEffectiveTools: [tool],
      trajectoryRecorder: null,
    });

    expect(hoisted.recordTrajectoryEvent).not.toHaveBeenCalled();
  });
});
