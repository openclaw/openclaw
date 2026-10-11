// Full-entry coverage for before_agent_reply hook handling before embedded attempts.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { readClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

async function prepareHookSession(sessionKey: string) {
  const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
  const sessionTarget = {
    agentId: "main",
    sessionId: "hook-admitted-run",
    sessionKey,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    expectedLifecycleRevision: "hook-admitted-revision",
  };
  await replaceSessionEntry(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    lifecycleRevision: sessionTarget.expectedLifecycleRevision,
    updatedAt: 1,
  });
  return {
    ...createOverflowRunParams(state),
    sessionId: sessionTarget.sessionId,
    sessionKey,
    sessionTarget,
    trigger: "cron" as const,
  };
}

describe("runEmbeddedAgent before_agent_reply seam", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.before-agent-reply-cron" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe(createOverflowRunParams(state).sessionKey);
    expect(hookContext?.workspaceDir).toBe(state.workspaceDir);
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("re-arms setup progress when its hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "cron",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "stable cron root", sessionKey: "agent:main:cron:hook-authority", fenced: true },
    { name: "ordinary session", sessionKey: "agent:main:hook-authority", fenced: false },
  ])("retains before-reply authority through a handled hook for $name", async (scenario) => {
    const params = await prepareHookSession(scenario.sessionKey);
    let requestAuthority: (() => void) | undefined;
    let claimAuthority: (() => void) | undefined;
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      requestAuthority = captureGuardedFetchRequestAuthority();
      claimAuthority = readClaimingHookAdmission(context)?.assertCurrent;
      if (scenario.fenced) {
        expect(requestAuthority).toBeTypeOf("function");
        expect(claimAuthority).toBeTypeOf("function");
        requestAuthority?.();
        claimAuthority?.();
      } else {
        expect(requestAuthority).toBeUndefined();
        expect(claimAuthority).toBeUndefined();
      }
      effect();
      return { handled: true, reply: { text: "hook completed" } };
    });

    const result = await runEmbeddedAgent(params);

    expect(result.payloads).toEqual([{ text: "hook completed" }]);
    expect(effect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    if (scenario.fenced) {
      expect(() => requestAuthority?.()).toThrow("Guarded request authority is no longer active");
      expect(() => claimAuthority?.()).toThrow();
    }
  });

  it("rejects a reassigned cron root before the before-reply hook effect", async () => {
    const params = await prepareHookSession("agent:main:cron:hook-rotation");
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(async () => {
      effect();
      return { handled: true, reply: { text: "stale hook result" } };
    });

    await expect(
      withBeforeAgentReplyObserver(
        {
          beforeDispatch: async () => {
            await replaceSessionEntry(params.sessionTarget, {
              sessionId: "replacement-cron-run",
              lifecycleRevision: "replacement-cron-revision",
              updatedAt: 2,
            });
          },
          afterDispatch: async (result) => result,
        },
        () => runEmbeddedAgent(params),
      ),
    ).rejects.toThrow("The original session generation no longer accepts this delivery");

    expect(effect).not.toHaveBeenCalled();
    expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("does not swallow cron-root revocation in a model-selection hook", async () => {
    const params = await prepareHookSession("agent:main:cron:model-hook-rotation");
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_model_resolve",
    );
    mockedGlobalHookRunner.runBeforeModelResolve.mockImplementationOnce(async () => {
      const assertRequestCurrent = captureGuardedFetchRequestAuthority();
      await replaceSessionEntry(params.sessionTarget, {
        sessionId: "replacement-model-run",
        lifecycleRevision: "replacement-model-revision",
        updatedAt: 2,
      });
      assertRequestCurrent?.();
      effect();
      return undefined;
    });

    await expect(runEmbeddedAgent(params)).rejects.toThrow(
      "The original session generation no longer accepts this delivery",
    );
    expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });
});
