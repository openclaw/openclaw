import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

const hoisted = vi.hoisted(() => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  hasHooks: vi.fn(() => true),
  log: { debug: vi.fn(), info: vi.fn(), isEnabled: vi.fn(() => false), warn: vi.fn() },
  onExecutionPhase: vi.fn(),
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
      onExecutionPhase: hoisted.onExecutionPhase,
      provider: "provider-1",
      runId: "run-1",
      senderId: "sender-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:discord:channel-1",
      trigger: "user",
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
    systemPromptText: "system prompt",
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

function expectDispatch(stages: number, trajectory: number, hooks: number) {
  expect(hoisted.recordStage).toHaveBeenCalledTimes(stages);
  expect(hoisted.recordTrajectoryEvent).toHaveBeenCalledTimes(trajectory);
  expect(hoisted.runLlmInput).toHaveBeenCalledTimes(hooks);
  expect(hoisted.emitTrustedDiagnosticEvent).toHaveBeenCalledOnce();
  expect(hoisted.onExecutionPhase).toHaveBeenCalledOnce();
}

describe("observeEmbeddedAttemptPrompt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the assembled prompt boundary and dispatches a cloned llm_input snapshot", () => {
    const input = observe();
    const stage = { prompt: "model prompt", messages: input.sessionMessages };
    expect(hoisted.recordStage.mock.calls.slice(0, 2)).toEqual([
      ["prompt:before", stage],
      ["prompt:images", { ...stage, note: "images: prompt=2" }],
    ]);
    expect(hoisted.recordTrajectoryEvent).toHaveBeenCalledWith(
      "context.compiled",
      expect.objectContaining({
        imagesCount: 2,
        providerVisibleTools: [{ name: "visible-tool" }],
        tools: [{ name: "visible-tool" }, { name: "deferred-tool" }],
        transcriptLeafId: "leaf-1",
      }),
    );
    expect(hoisted.emitTrustedDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "context.assembled",
        contextTokenBudget: 32_000,
        historyTextChars: 7,
        messageCount: 1,
        promptChars: 16,
        reserveTokens: 4_096,
      }),
    );
    expect(hoisted.onExecutionPhase).toHaveBeenCalledWith({
      phase: "context_assembled",
      provider: "provider-1",
      model: "model-1",
    });
    expect(hoisted.runLlmInput).toHaveBeenCalledOnce();
    const [event, context] = hoisted.runLlmInput.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      prompt: "[boundary] model prompt",
      imagesCount: 2,
      tools: [{ name: "hook-tool" }],
    });
    expect(event?.historyMessages).toEqual(input.hookMessagesForCurrentPrompt);
    expect(event?.historyMessages).not.toBe(input.hookMessagesForCurrentPrompt);
    expect(context).toMatchObject({ agentId: "main", channel: "discord", senderId: "sender-1" });
  });

  it("marks a blank current prompt as skipped while preserving its compiled trace", () => {
    const input = observe({ imageCount: 0, promptForModel: "   " }, true);
    expect(hoisted.recordTrajectoryEvent).toHaveBeenNthCalledWith(
      1,
      "context.compiled",
      expect.any(Object),
    );
    expect(hoisted.recordTrajectoryEvent).toHaveBeenNthCalledWith(2, "prompt.skipped", {
      reason: "blank_user_prompt",
      prompt: "   ",
      messages: input.sessionMessages,
      imagesCount: 0,
    });
    expect(hoisted.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("embedded run prompt skipped: blank user prompt"),
    );
    expectDispatch(2, 2, 0);
  });

  it("keeps an already-blocked prompt out of cache, trajectory, and hook dispatch", () => {
    observe({ skipPromptSubmission: true }, true);
    expectDispatch(0, 0, 0);
  });

  it.each([false, true])("ignores unrecorded tool metadata (compacted=%s)", (compacted) => {
    const tool = {
      get name(): string {
        throw new Error("unrecorded tool metadata must not be read");
      },
    };
    observe({
      effectiveTools: [tool],
      uncompactedEffectiveTools: [tool],
      toolSearchCompacted: compacted,
      trajectoryRecorder: null,
    });

    expectDispatch(2, 0, 1);
  });
});
