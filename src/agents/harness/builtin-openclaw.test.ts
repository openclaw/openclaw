import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import * as fixtures from "./lifecycle.test-support.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "./types.js";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());
const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());

vi.mock("../embedded-agent-runner/run/attempt.js", () => ({ runEmbeddedAttempt }));
vi.mock("../simple-completion-execution.js", () => ({ completeWithPreparedSimpleCompletionModel }));

import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";

const deadline = { kind: "bounded" as const, deadlineAtMs: 123_456 };
const lifecycle = (phase: string) => ({ stream: "lifecycle", data: { phase } });

describe("createOpenClawAgentHarness", () => {
  let harness: ReturnType<typeof createOpenClawAgentHarness>;
  beforeEach(() => {
    harness = createOpenClawAgentHarness();
    runEmbeddedAttempt.mockReset().mockImplementation(async (params: EmbeddedRunAttemptParams) => {
      params.onAttemptDeadlineChanged?.(deadline);
      params.onAttemptTimeoutArmed?.();
      await params.onAgentEvent?.(lifecycle("start"));
      await params.onAgentEvent?.(lifecycle(params.deferTerminalLifecycle ? "finishing" : "end"));
      return {
        ...fixtures.createAttemptResult(),
        currentAttemptCompletedAssistant: fixtures.createFinalAssistant(),
      };
    });
    completeWithPreparedSimpleCompletionModel.mockReset();
  });

  it("brands only host-created instances as the built-in runtime", () => {
    expect(isBuiltInOpenClawAgentHarness(harness)).toBe(true);
    expect(isBuiltInOpenClawAgentHarness({ ...harness, label: "forged" })).toBe(false);
  });

  it.each([true, false])(
    "captures live support=%s and invocation state in async custody",
    async (liveSupport) => {
      const scope = new AsyncLocalStorage<object>();
      const owner = {};
      const onAgentEvent = vi.fn(() => {
        expect(scope.getStore()).toBe(owner);
      });
      harness.supportsTurnScopedToolRestrictions = liveSupport;
      const params = {
        thinkLevel: "ultra",
        onAgentEvent,
        supportsTurnScopedToolRestrictions: true,
      };
      const pending = scope.run(owner, () => harness.runAttempt(params as never));
      params.thinkLevel = "off";
      harness.supportsTurnScopedToolRestrictions = !liveSupport;
      await pending;

      expect(runEmbeddedAttempt).toHaveBeenCalledWith({
        thinkLevel: "ultra",
        onAgentEvent,
        supportsTurnScopedToolRestrictions: liveSupport,
      });
      expect(onAgentEvent).toHaveBeenCalledTimes(2);
    },
  );

  it("enforces tool-free finalization while forwarding execution and lifecycle notifications", async () => {
    const prepareAssistantTranscriptMessage = vi.fn();
    const onAttemptDeadlineChanged = vi.fn();
    const onAttemptTimeoutArmed = vi.fn();
    const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
    const ambient = {
      extraSystemPrompt: "ambient system context",
      skillsSnapshot: { prompt: "ambient skills" },
      currentInboundContext: { text: "ambient inbound context" },
      internalEvents: [{ type: "ambient-event" }],
      trigger: "heartbeat",
      onPartialReply: vi.fn(),
    };
    const attempt = {
      ...ambient,
      prompt: "finalize",
      sessionManager: { owner: "host" },
      sessionPersistence: "detached",
      disableTools: false,
      onAttemptDeadlineChanged,
      onAttemptTimeoutArmed,
      onAgentEvent,
      deferTerminalLifecycle: true,
      prepareAssistantTranscriptMessage,
    };
    const pending = harness.finalizeSettledTurn?.({
      attempt: attempt as never,
      settledAttempt: {} as never,
    });
    attempt.prompt = "changed after invocation";
    attempt.sessionManager = { owner: "other" };
    attempt.onAgentEvent = vi.fn();
    await pending;

    expect(onAttemptDeadlineChanged).toHaveBeenCalledExactlyOnceWith(deadline);
    expect(onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(onAgentEvent.mock.calls).toEqual([[lifecycle("start")], [lifecycle("finishing")]]);
    const finalizationAttempt = runEmbeddedAttempt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(finalizationAttempt).toMatchObject({
      prompt: "finalize",
      sessionManager: { owner: "host" },
      sessionPersistence: "detached",
      disableTools: true,
      disableTrajectory: true,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
      initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
      operation: "settled-tool-finalization",
      prepareAssistantTranscriptMessage,
    });
    for (const key of Object.keys(ambient)) {
      expect(finalizationAttempt).not.toHaveProperty(key);
    }
  });

  it("rejects harness-owned isolated authorization", async () => {
    const params = {
      ...fixtures.createAttemptParams(),
      authorization: {
        owner: "harness",
        plan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
        authProfileStore: { version: 1, profiles: {} },
      },
      config: {},
      systemPrompt: "system",
      agentId: "main",
      agentDir: "/tmp/agent",
    } satisfies AgentHarnessIsolatedCompletionParamsV2;

    await expect(harness.runIsolatedCompletionV2?.(params)).rejects.toThrow(
      "requires host-prepared authorization",
    );
    expect(completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });
});
