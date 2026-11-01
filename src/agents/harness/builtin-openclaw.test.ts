import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
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
    const onAgentEvent = vi.fn(() => {
      expect(scope.getStore()).toBe(harness);
    });
    harness.supportsTurnScopedToolRestrictions = liveSupport;
    const params = {
      thinkLevel: "ultra",
      onAgentEvent,
      supportsTurnScopedToolRestrictions: true,
    };
    const pending = scope.run(harness, () => harness.runAttempt(params as never));
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

it.each([undefined, "openclaw-transcript", "unavailable", "harness", null])(
  "enforces isolated finalization context=%s and lifecycle custody",
  async (source) => {
    const ambient = {
      extraSystemPrompt: "ambient system context",
      skillsSnapshot: { prompt: "ambient skills" },
      currentInboundContext: { text: "ambient inbound context" },
      internalEvents: [{ type: "ambient-event" }],
      trigger: "heartbeat",
      onPartialReply: vi.fn(),
    };
    const forwarded = {
      prompt: "finalize",
      sessionManager: { owner: "host" },
      sessionPersistence: "detached",
      prepareAssistantTranscriptMessage: vi.fn(),
      onAttemptDeadlineChanged: vi.fn(),
      onAttemptTimeoutArmed: vi.fn(),
      onAgentEvent: vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>(),
      deferTerminalLifecycle: true,
    };
    const attempt = { ...ambient, ...forwarded, disableTools: false };
    const messages = Object.freeze([{ role: "user" as const, content: "assembled", timestamp: 1 }]);
    const pending = harness.finalizeSettledTurn?.({
      attempt: attempt as never,
      settledAttempt: {
        messagesSnapshot: source === null ? undefined : messages,
        settledTurnFinalizationContext: source ? { source, messages } : undefined,
      } as never,
    });
    if (source === "unavailable" || source === "harness" || source === null) {
      await expect(pending).rejects.toThrow("requires the settled attempt transcript view");
      expect(runEmbeddedAttempt).not.toHaveBeenCalled();
      return;
    }
    attempt.prompt = "changed after invocation";
    attempt.sessionManager = { owner: "other" };
    attempt.onAgentEvent = vi.fn();
    await pending;

    expect(forwarded.onAttemptDeadlineChanged).toHaveBeenCalledExactlyOnceWith(deadline);
    expect(forwarded.onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    const events = forwarded.onAgentEvent.mock.calls;
    expect(events).toEqual([[lifecycle("start")], [lifecycle("finishing")]]);
    const finalizationAttempt = runEmbeddedAttempt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(finalizationAttempt).toMatchObject({
      ...forwarded,
      settledTurnFinalizationMessages: messages,
      disableTools: true,
      disableTrajectory: true,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
      initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
      operation: "settled-tool-finalization",
    });
    for (const key of Object.keys(ambient)) {
      expect(finalizationAttempt).not.toHaveProperty(key);
    }
  },
);

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
