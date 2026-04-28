import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness, createCodexAppServerAgentHarnessV2 } from "./harness.js";

const { runCodexAppServerAttempt } = vi.hoisted(() => ({
  runCodexAppServerAttempt: vi.fn(),
}));

vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt,
}));

function createAttemptParams(): AgentHarnessAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "session-key",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" },
    authStorage: {},
    modelRegistry: {},
    thinkLevel: "low",
    messageChannel: "qa",
    trigger: "manual",
  } as AgentHarnessAttemptParams;
}

function createAttemptResult(): AgentHarnessAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: ["codex ok"],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  } as AgentHarnessAttemptResult;
}

describe("Codex app-server native Harness V2 factory", () => {
  it("preserves Codex support policy while exposing a native V2 lifecycle", async () => {
    const pluginConfig = { mode: "test" };
    const params = createAttemptParams();
    const result = createAttemptResult();
    runCodexAppServerAttempt.mockResolvedValueOnce(result);

    const v1 = createCodexAppServerAgentHarness({ pluginConfig });
    const v2 = createCodexAppServerAgentHarnessV2(v1, { pluginConfig });

    expect(v2.id).toBe("codex");
    expect(
      v2.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" }),
    ).toMatchObject({ supported: true, priority: 100 });
    expect(
      v2.supports({ provider: "openai-codex", modelId: "gpt-5.4", requestedRuntime: "auto" }),
    ).toMatchObject({ supported: false });

    const prepared = await v2.prepare(params);
    const session = await v2.start(prepared);

    expect(prepared.lifecycleState).toBe("prepared");
    expect(session.lifecycleState).toBe("started");
    await expect(v2.send(session)).resolves.toBe(result);
    expect(runCodexAppServerAttempt).toHaveBeenCalledWith(params, { pluginConfig });
    await expect(v2.resolveOutcome(session, result)).resolves.toMatchObject({
      agentHarnessId: "codex",
      sessionIdUsed: "session-1",
    });
  });

  it("keeps compact reset and dispose delegated to the V1 compatibility harness", async () => {
    const params = createAttemptParams();
    const compact = vi.fn(async () => ({ ok: true, compacted: false as const }));
    const reset = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const v1: AgentHarness = {
      id: "codex",
      label: "Codex agent harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      compact,
      reset,
      dispose,
    };

    const v2 = createCodexAppServerAgentHarnessV2(v1);

    await expect(
      v2.compact?.({
        sessionId: "session-1",
        sessionKey: "session-key",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        model: "gpt-5.4",
      }),
    ).resolves.toMatchObject({ ok: true, compacted: false });
    await v2.reset?.({ sessionId: params.sessionId, reason: "reset" });
    await v2.dispose?.();

    expect(compact).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({ sessionId: params.sessionId, reason: "reset" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("applies V1 classification semantics during native V2 outcome resolution", async () => {
    const params = createAttemptParams();
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty");
    const v1: AgentHarness = {
      id: "codex",
      label: "Codex agent harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      classify,
    };
    const v2 = createCodexAppServerAgentHarnessV2(v1);
    const session = await v2.start(await v2.prepare(params));
    const result = {
      ...createAttemptResult(),
      agentHarnessResultClassification: "reasoning-only",
    } as AgentHarnessAttemptResult;

    await expect(v2.resolveOutcome(session, result)).resolves.toMatchObject({
      agentHarnessId: "codex",
      agentHarnessResultClassification: "empty",
    });
    expect(classify).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentHarnessResultClassification: expect.anything() }),
      params,
    );
  });
});
