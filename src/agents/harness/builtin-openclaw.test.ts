// Built-in OpenClaw harness tests cover logical thinking-mode boundaries.
import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());
const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());

vi.mock("../embedded-agent-runner/run/attempt.js", () => ({ runEmbeddedAttempt }));
vi.mock("../simple-completion-execution.js", () => ({ completeWithPreparedSimpleCompletionModel }));

import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";

describe("createOpenClawAgentHarness", () => {
  beforeEach(() => {
    runEmbeddedAttempt.mockReset();
    runEmbeddedAttempt.mockImplementation(async (params: EmbeddedRunAttemptParams) => {
      params.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: 123_456 });
      params.onAttemptTimeoutArmed?.();
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: params.deferTerminalLifecycle ? "finishing" : "end" },
      });
      return {
        terminal: { kind: "ok" },
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        assistantTexts: ["done"],
        toolMetas: [],
        lastAssistant: undefined,
        currentAttemptCompletedAssistant: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      };
    });
    completeWithPreparedSimpleCompletionModel.mockReset();
    completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    });
  });

  it("brands only host-created instances as the built-in runtime", () => {
    expect(isBuiltInOpenClawAgentHarness(createOpenClawAgentHarness())).toBe(true);
    expect(
      isBuiltInOpenClawAgentHarness({
        id: "openclaw",
        label: "forged",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("must not run");
        },
      }),
    ).toBe(false);
  });

  it("captures invocation state before loading the runner and preserves async custody", async () => {
    const scope = new AsyncLocalStorage<object>();
    const owner = {};
    const onAgentEvent = vi.fn(() => {
      expect(scope.getStore()).toBe(owner);
    });
    const params = { thinkLevel: "ultra", onAgentEvent };
    const harness = createOpenClawAgentHarness();
    const pending = scope.run(owner, () => harness.runAttempt(params as never));
    params.thinkLevel = "off";
    harness.supportsTurnScopedToolRestrictions = false;
    await pending;

    expect(runEmbeddedAttempt).toHaveBeenCalledWith({
      thinkLevel: "ultra",
      onAgentEvent,
      supportsTurnScopedToolRestrictions: true,
    });
    expect(onAgentEvent).toHaveBeenCalledTimes(2);
  });

  it("carries only explicit live harness support", async () => {
    const harness = createOpenClawAgentHarness();
    harness.supportsTurnScopedToolRestrictions = false;
    await harness.runAttempt({ supportsTurnScopedToolRestrictions: true } as never);
    expect(runEmbeddedAttempt).toHaveBeenCalledWith({ supportsTurnScopedToolRestrictions: false });
  });

  it("enforces tool-free finalization while forwarding execution and lifecycle notifications", async () => {
    const sessionManager = { owner: "host" };
    const prepareAssistantTranscriptMessage = vi.fn();
    const onAttemptDeadlineChanged = vi.fn();
    const onAttemptTimeoutArmed = vi.fn();
    const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
    const attempt = {
      prompt: "finalize",
      sessionManager,
      sessionPersistence: "detached",
      disableTools: false,
      extraSystemPrompt: "ambient system context",
      skillsSnapshot: { prompt: "ambient skills" },
      currentInboundContext: { text: "ambient inbound context" },
      internalEvents: [{ type: "ambient-event" }],
      trigger: "heartbeat",
      onPartialReply: vi.fn(),
      onAttemptDeadlineChanged,
      onAttemptTimeoutArmed,
      onAgentEvent,
      deferTerminalLifecycle: true,
      prepareAssistantTranscriptMessage,
    };
    const harness = createOpenClawAgentHarness();

    const pending = harness.finalizeSettledTurn?.({
      attempt: attempt as never,
      settledAttempt: {} as never,
    });
    attempt.prompt = "changed after invocation";
    attempt.sessionManager = { owner: "other" };
    attempt.onAgentEvent = vi.fn();
    await pending;

    expect(onAttemptDeadlineChanged).toHaveBeenCalledExactlyOnceWith({
      kind: "bounded",
      deadlineAtMs: 123_456,
    });
    expect(onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(onAgentEvent.mock.calls).toEqual([
      [{ stream: "lifecycle", data: { phase: "start" } }],
      [{ stream: "lifecycle", data: { phase: "finishing" } }],
    ]);
    expect(runEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "finalize",
        sessionManager,
        sessionPersistence: "detached",
        disableTools: true,
        disableTrajectory: true,
        skipPreparedUserTurnMessage: true,
        suppressNextUserMessagePersistence: true,
        initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
        operation: "settled-tool-finalization",
        prepareAssistantTranscriptMessage,
      }),
    );
    const finalizationAttempt = runEmbeddedAttempt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(finalizationAttempt).not.toHaveProperty("extraSystemPrompt");
    expect(finalizationAttempt).not.toHaveProperty("skillsSnapshot");
    expect(finalizationAttempt).not.toHaveProperty("currentInboundContext");
    expect(finalizationAttempt).not.toHaveProperty("internalEvents");
    expect(finalizationAttempt).not.toHaveProperty("trigger");
    expect(finalizationAttempt).not.toHaveProperty("onPartialReply");
  });

  it("rejects harness-owned isolated authorization", async () => {
    const params = {
      authorization: {
        owner: "harness",
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
        },
        authProfileStore: { version: 1, profiles: {} },
      },
      config: {},
      systemPrompt: "system",
      prompt: "user",
      timeoutMs: 1_000,
      provider: "openai",
      modelId: "gpt-test",
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    } satisfies Parameters<
      NonNullable<ReturnType<typeof createOpenClawAgentHarness>["runIsolatedCompletionV2"]>
    >[0];

    await expect(createOpenClawAgentHarness().runIsolatedCompletionV2?.(params)).rejects.toThrow(
      "requires host-prepared authorization",
    );
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });
});
