import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { captureGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { readClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner as hooks,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

const firstBeforeAgentReplyCall = () =>
  expectDefined(hooks.runBeforeAgentReply.mock.calls[0], "before_agent_reply call");
const handledReply = (text: string) => ({ handled: true, reply: { text } });

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
    state = await createFreshRunIntegrationState("run.before-agent-reply-cron");
    hooks.hasHooks.mockImplementation((hookName: string) => hookName === "before_agent_reply");
  });

  afterEach(() => state?.cleanup());

  it("re-arms setup progress when a scheduled hook does not claim", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...(await prepareHookSession("agent:main:cron:scheduled")),
      provider: "test-local",
      model: "test-model",
      config: {
        models: {
          providers: {
            "test-local": {
              baseUrl: "http://127.0.0.1:11434/v1",
              api: "openai-completions",
              auth: "none",
              models: [],
            },
          },
        },
      },
      onExecutionPhase,
    });

    expect(firstBeforeAgentReplyCall()[1]).toMatchObject({
      sessionKey: "agent:main:cron:scheduled",
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
    { name: "stable cron root", sessionKey: "agent:main:cron:hook-authority" },
    { name: "ordinary session", sessionKey: "agent:main:hook-authority" },
  ])("retains before-reply authority through a handled hook for $name", async (scenario) => {
    const params = {
      ...(await prepareHookSession(scenario.sessionKey)),
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
    };
    let requestAuthority: (() => void) | undefined;
    let claimAuthority: (() => void) | undefined;
    const effect = vi.fn();
    hooks.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      requestAuthority = captureGuardedFetchRequestAuthority();
      claimAuthority = readClaimingHookAdmission(context)?.assertCurrent;
      expect(requestAuthority).toBeTypeOf("function");
      expect(claimAuthority).toBeTypeOf("function");
      requestAuthority?.();
      claimAuthority?.();
      effect();
      return handledReply("hook completed");
    });

    const result = await runEmbeddedAgent(params);
    const [payload, context] = firstBeforeAgentReplyCall();
    expect(payload).toEqual({ cleanedBody: params.prompt });
    expect(context).toMatchObject({
      jobId: params.jobId,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: state.workspaceDir,
      trigger: "cron",
    });
    const { senderId, chatId, channel } = context;
    expect([senderId, chatId, channel]).toEqual([undefined, undefined, undefined]);
    expect(result.payloads).toEqual([{ text: "hook completed" }]);
    expect(result.meta.providerStarted).toBe(false);
    expect(effect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(() => requestAuthority?.()).toThrow("Guarded request authority is no longer active");
    expect(() => claimAuthority?.()).toThrow();
  });

  it("stops ordinary reply effects when cancelled during attribution capture", async () => {
    const entered = createDeferred();
    const baseline = createDeferred();
    const controller = new AbortController();
    const failure = new Error("ordinary turn cancelled");
    const pending = runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "user",
      abortSignal: controller.signal,
      awaitSessionDiffBaseline: () => {
        entered.resolve();
        return baseline.promise;
      },
    });
    void pending.catch(() => {});
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Reply bypassed attribution");
      expect(hooks.runBeforeAgentReply).not.toHaveBeenCalled();
      controller.abort(failure);
      baseline.resolve();
      await expect(pending).rejects.toBe(failure);
      expect(hooks.runBeforeAgentReply).not.toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      baseline.resolve();
      await pending.catch(() => undefined);
    }
  });

  it.each(["before-reply", "model-selection"] as const)(
    "rejects a reassigned cron root during %s without running effects",
    async (phase) => {
      const params = await prepareHookSession(`agent:main:cron:${phase}-rotation`);
      const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
      const effect = vi.fn();
      const revoke = () =>
        replaceSessionEntry(params.sessionTarget, {
          sessionId: "replacement-cron-run",
          lifecycleRevision: "replacement-cron-revision",
          updatedAt: 2,
        });
      let run = () => runEmbeddedAgent(params);
      if (phase === "before-reply") {
        hooks.runBeforeAgentReply.mockImplementation(async () => {
          effect();
          return handledReply("stale hook result");
        });
        run = () =>
          withBeforeAgentReplyObserver(
            {
              beforeDispatch: () => revoke().then(() => undefined),
              afterDispatch: async (result) => result,
            },
            () => runEmbeddedAgent(params),
          );
      } else {
        hooks.hasHooks.mockImplementation(
          (hookName: string) => hookName === "before_model_resolve",
        );
        hooks.runBeforeModelResolve.mockImplementationOnce(async () => {
          const assertRequestCurrent = captureGuardedFetchRequestAuthority();
          await revoke();
          assertRequestCurrent?.();
          effect();
          return undefined;
        });
      }
      await expect(run()).rejects.toThrow(
        "The original session generation no longer accepts this delivery",
      );
      if (phase === "before-reply") {
        expect(hooks.runBeforeAgentReply).not.toHaveBeenCalled();
      } else {
        expect(hooks.runBeforeModelResolve).toHaveBeenCalledOnce();
      }
      expect(effect).not.toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    },
  );
});
