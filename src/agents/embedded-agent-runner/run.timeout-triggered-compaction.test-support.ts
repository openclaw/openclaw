import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../harness/types.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedBuildAgentRuntimePlan,
  mockedCompactDirect,
  mockedGetApiKeyForModel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import { resolveEmbeddedRunAbandonment, markActiveEmbeddedRunAbandoned } from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as runsTesting,
} from "./runs.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

type CompactParams = Parameters<ContextEngine["compact"]>[0];

describe("runEmbeddedAgent timeout recovery composition", () => {
  let fixture: Pick<OpenClawTestState, "cleanup"> | undefined;

  async function createSession() {
    const session = await createSharedRunIntegrationSession();
    fixture = session;
    return session;
  }

  async function createState() {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const state = await createOpenClawTestState({ label: "run.timeout-triggered-compaction" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    fixture = state;
    return { state, setRuntimeConfigSnapshot };
  }

  const timeoutAttempt = (input = 160_000) => ({
    timedOut: true,
    lastAssistant: { role: "assistant", content: [], usage: { input } } as never,
  });
  const compacted = (
    sessionTarget?: Parameters<typeof makeCompactionSuccess>[0]["sessionTarget"],
  ) =>
    makeCompactionSuccess({
      summary: "compacted for timeout",
      tokensBefore: 160_000,
      tokensAfter: 60_000,
      sessionTarget,
    });

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(async () => {
    try {
      await fixture?.cleanup();
    } finally {
      fixture = undefined;
    }
  });

  it("adopts a compacted transcript and retries with a continuation prompt", async () => {
    const session = await createSession();
    const successor = {
      ...session.runParams.sessionTarget,
      sessionId: `${session.runParams.sessionId}-timeout-rotated`,
    };
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        params.onUserMessagePersisted?.(makeUserMessage("hello", 1));
        return session.makeAttemptResult(timeoutAttempt());
      })
      .mockResolvedValueOnce(
        session.makeAttemptResult({
          sessionIdUsed: successor.sessionId,
          sessionFileUsed: successor.sessionKey,
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(compacted(successor));

    const result = await runEmbeddedAgent({
      ...session.runParams,
      messageChannel: "slack",
      currentThreadTs: "thread-1",
    });

    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      sessionId: successor.sessionId,
      sessionFile: successor.sessionKey,
      sessionTarget: successor,
      prompt: expect.stringContaining("Continue the current task from the existing transcript"),
    });
    expect(mockedCompactDirect.mock.calls[0]?.[0]).toMatchObject({
      sessionId: session.runParams.sessionId,
      tokenBudget: 200_000,
      force: true,
      compactionTarget: "budget",
      runtimeContext: {
        trigger: "timeout_recovery",
        attempt: 1,
        maxAttempts: 2,
        messageChannel: "slack",
        currentThreadTs: "thread-1",
      },
    });
    expect(result.meta.agentMeta?.compactionTokensAfter).toBe(60_000);
  });

  it("restores terminal abandonment when retry preparation fails before registration", async () => {
    const session = await createSession();
    const preparationError = new Error("next attempt preparation failed");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      const handle = createEmbeddedRunHandle({ runId: params.runId });
      setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
      expect(
        markActiveEmbeddedRunAbandoned({
          sessionId: params.sessionId,
          handle,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          reason: "timeout",
        }),
      ).toBe(true);
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
      return session.makeAttemptResult(timeoutAttempt());
    });
    mockedCompactDirect.mockResolvedValueOnce(compacted());
    const defaultBuildRuntimePlan = mockedBuildAgentRuntimePlan.getMockImplementation();
    mockedBuildAgentRuntimePlan
      .mockImplementationOnce(defaultBuildRuntimePlan!)
      .mockImplementationOnce(() => {
        throw preparationError;
      });

    await expect(runEmbeddedAgent(session.runParams)).rejects.toBe(preparationError);

    expect(
      resolveEmbeddedRunAbandonment({
        sessionId: session.runParams.sessionId,
        sessionKey: session.runParams.sessionKey,
      }),
    ).toBe("timeout");
  });

  it("leaves timeout recovery to a forced unlocked Codex compaction owner", async () => {
    const { state, setRuntimeConfigSnapshot } = await createState();
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult(timeoutAttempt(150_000)),
    );
    const nativeCompact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
      compact: nativeCompact,
    });

    const config = {
      agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
    };
    setRuntimeConfigSnapshot(config);
    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.5",
      config,
      runId: "forced-unlocked-codex-timeout-owner",
    }).finally(clearAgentHarnesses);

    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(nativeCompact).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("keeps the timeout compaction cap across auth-profile rotation", async () => {
    const session = await createSession();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mockedResolveAuthProfileOrder.mockReturnValue(["profile-a", "profile-b"]);
    mockedGetApiKeyForModel.mockImplementation(async (params = {}) => ({
      apiKey: "fixture",
      profileId: params.profileId ?? "profile-a",
      source: "test",
      mode: "api-key",
    }));
    mockedRunEmbeddedAttempt.mockResolvedValue(
      session.makeAttemptResult({
        ...timeoutAttempt(150_000),
        aborted: true,
      }),
    );
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedAgent(session.runParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(
      mockedCompactDirect.mock.calls.map(
        ([params]) => (params as CompactParams).runtimeContext?.authProfileId,
      ),
    ).toEqual(["profile-a", "profile-b"]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("lets one silent idle timeout retry before the normal timeout surface", async () => {
    const { state } = await createState();
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          ...timeoutAttempt(20_000),
          idleTimedOut: true,
          assistantTexts: [],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedAgent(createOverflowRunParams(state));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).not.toBe(true);
  });
});
