// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { PluginHookBeforePromptBuildResult } from "../../../plugins/hook-before-agent-start.types.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { testing as announceTesting } from "../../subagents/announce/subagent-announce-output.test-support.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../../subagents/registry/subagent-lifecycle-events.js";
import { markPendingFinalDelivery } from "../../subagents/registry/subagent-registry-lifecycle-delivery.js";
import { SubagentLifecycleController } from "../../subagents/registry/subagent-registry-lifecycle.js";
import { createSubagentRegistryPublicApi } from "../../subagents/registry/subagent-registry-public-api.js";
import type { SubagentRunRecord } from "../../subagents/registry/subagent-registry.types.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

const steeringMocks = vi.hoisted(() => ({
  lease: vi.fn<
    ReturnType<typeof createSubagentRegistryPublicApi>["leasePendingAgentSteeringItems"]
  >(async () => undefined),
}));

vi.mock("../../subagents/registry/subagent-registry.js", async () => {
  const { prependAgentSteeringPrompt } = await import("../../agent-steering-queue.js");
  return { leasePendingAgentSteeringItems: steeringMocks.lease, prependAgentSteeringPrompt };
});

// Completion storage and queue consumption stay real; terminal cleanup is outside this turn.
vi.mock("../../subagents/registry/subagent-registry-lifecycle-cleanup.js", () => ({
  completeTerminalEffects: vi.fn(async () => {}),
}));

registerAgentSessionLoopTestLifecycle();

beforeEach(() => {
  vi.restoreAllMocks();
  steeringMocks.lease.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  announceTesting.setDepsForTest();
  vi.restoreAllMocks();
});

async function assembleWithCapturedHookCtx(
  runId: string,
  attemptOverrides?: Partial<EmbeddedRunAttemptParams>,
  promptPolicy: {
    hookResult?: PluginHookBeforePromptBuildResult;
    applyPromptBuildToolsAllow?: Parameters<
      typeof prepareEmbeddedAttemptPromptAssembly
    >[0]["applyPromptBuildToolsAllow"];
    prepareSystemPrompt?: Parameters<
      typeof prepareEmbeddedAttemptPromptAssembly
    >[0]["prepareSystemPrompt"];
  } = {},
) {
  const { session, sessionManager, modelRegistry } = await createTestSession();
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "provenance-hook-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    config: {},
    model: testModel,
    modelId: testModel.id,
    provider: testModel.provider,
    thinkLevel: "off",
    prompt: "Handoff payload",
    transcriptPrompt: "Handoff payload",
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
    workspaceDir: "/tmp/provenance-hook-test",
    ...attemptOverrides,
  };
  const captured: PluginHookAgentContext[] = [];
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        handler: async (_event: unknown, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
          return promptPolicy.hookResult;
        },
      },
    ],
  });
  const setLeasedSteering =
    vi.fn<Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["setLeasedSteering"]>();
  const setSystemPrompt = vi.fn<(prompt: string) => void>();
  const priorMessages = structuredClone(session.messages);
  const prompt = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession: session,
    sessionManager,
    hookRunner,
    hookAgentId: "main",
    diagnosticTrace: { traceId: "11111111111111111111111111111111" },
    isRawModelRun: false,
    sessionAgentId: "main",
    runtimeModel: testModel.id,
    systemPromptText: "Base system prompt",
    applyPromptBuildToolsAllow: promptPolicy.applyPromptBuildToolsAllow ?? (() => []),
    prepareSystemPrompt: promptPolicy.prepareSystemPrompt,
    setActiveSessionSystemPrompt: setSystemPrompt,
    setLeasedSteering,
  });
  expect(session.messages).toEqual(priorMessages);
  return { captured, prompt, setLeasedSteering, setSystemPrompt };
}

describe("prompt-build hook context input provenance", () => {
  it("prepares the restricted prompt once before composing the original hook additions", async () => {
    const order: string[] = [];
    const applyPolicy = vi.fn((names: string[] | undefined) => {
      order.push("policy");
      expect(names).toEqual(["read"]);
      return ["read"];
    });
    const prepareSystemPrompt = vi.fn(async (current: string) => {
      order.push("prompt");
      expect(current).toBe("Base system prompt");
      return "Filtered capability guidance";
    });
    const { captured, setSystemPrompt } = await assembleWithCapturedHookCtx(
      "prompt-policy-composition",
      undefined,
      {
        hookResult: {
          toolsAllow: ["read"],
          prependSystemContext: "Hook prefix",
          appendSystemContext: "Hook suffix",
        },
        applyPromptBuildToolsAllow: applyPolicy,
        prepareSystemPrompt,
      },
    );
    expect(order).toEqual(["policy", "prompt"]);
    expect(captured).toHaveLength(1);
    expect(prepareSystemPrompt).toHaveBeenCalledOnce();
    const finalPrompt = setSystemPrompt.mock.calls.at(-1)?.[0] ?? "";
    expect(finalPrompt).toContain("Filtered capability guidance");
    expect(finalPrompt).toContain("Hook prefix");
    expect(finalPrompt).toContain("Hook suffix");
    expect(finalPrompt).not.toContain("Base system prompt");
    expect(finalPrompt.match(/Hook prefix/g)).toHaveLength(1);
    expect(finalPrompt.match(/Hook suffix/g)).toHaveLength(1);
  });

  it("exposes inter-session provenance on the before_prompt_build context", async () => {
    const { captured } = await assembleWithCapturedHookCtx("provenance-hook-inter-session", {
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:session-a",
        sourceTool: "sessions_send",
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      trigger: "user",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:session-a",
        sourceTool: "sessions_send",
      },
    });
  });

  it("leaves provenance undefined for ordinary human turns", async () => {
    const { captured } = await assembleWithCapturedHookCtx("provenance-hook-human-turn");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ trigger: "user" });
    expect(captured[0]?.inputProvenance).toBeUndefined();
  });
});

it("injects complete lifecycle results into requester prompts and acknowledges one whole item", async () => {
  const requesterSessionKey = "agent:main:steering-requester";
  const answers = [`${"<result>".repeat(2_100)}required first tail`, "later child result"];
  const children: SubagentRunRecord[] = answers.map((_answer, index) => ({
    runId: `child-run-${index}`,
    childSessionKey: `agent:main:subagent:steering-${index}`,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: "Return the complete findings",
    cleanup: "keep",
    createdAt: 1_000 + index,
    expectsCompletionMessage: true,
    execution: {
      status: "running",
      startedAt: 2_000,
      transcriptTarget: {
        agentId: "main",
        sessionId: `child-session-${index}`,
        sessionKey: `agent:main:subagent:steering-${index}`,
        storePath: "/tmp/steering-test-sessions",
      },
    },
  }));
  const runs = new Map(children.map((child) => [child.runId, child]));
  const persist = vi.fn();
  const controller = new SubagentLifecycleController({
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    persist,
    persistOrThrow: persist,
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: () => null,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: vi.fn(async () => {
      throw new Error("unexpected Gateway call");
    }),
    captureSubagentCompletionReply: vi.fn(async () => {
      throw new Error("producer evidence must own stored completion");
    }),
    runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
    warn: vi.fn(),
  });
  onTestFinished(() => controller.clearScheduledResumeTimers());
  const transcripts = new Map<string, unknown[]>();
  const assistant = (runId: string, text: string) => ({
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      __openclaw: { runId },
    },
  });
  for (const [index, child] of children.entries()) {
    const answer = answers[index];
    if (answer === undefined) {
      throw new Error("expected a transcript answer for each child");
    }
    await controller.completeSubagentRun({
      runId: child.runId,
      endedAt: 3_000 + index,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
      terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: answer }),
    });
    markPendingFinalDelivery({ entry: child });
    transcripts.set(`child-session-${index}`, [
      assistant("previous-run", "stale result"),
      assistant(child.runId, answer),
      assistant("replacement-run", "unrelated later result"),
    ]);
  }
  const [first, second] = children;
  if (!first || !second) {
    throw new Error("expected two completed children for requester queue delivery");
  }
  expect(first.completion?.resultText).toHaveLength(4_096);
  const storedCompletion = structuredClone(first.completion);
  announceTesting.setDepsForTest({
    findTranscriptEvent: async ({ sessionId }, match) => {
      const event = transcripts
        .get(sessionId)
        ?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    },
  });
  const api = createSubagentRegistryPublicApi({
    runs,
    persist,
    persistOrThrow: persist,
    restoreOnce: vi.fn(),
    startAnnounceCleanup: vi.fn(() => false),
    settleRequesterTurn: controller.settleRequesterTurnAfterSessionSpawns,
  });
  steeringMocks.lease.mockImplementation(api.leasePendingAgentSteeringItems);

  const firstTurn = await assembleWithCapturedHookCtx("steering-first-turn", {
    sessionKey: requesterSessionKey,
  });

  const escapedAnswer = `${"&lt;result&gt;".repeat(2_100)}required first tail`;
  for (const prompt of [
    firstTurn.prompt.effectivePrompt,
    firstTurn.prompt.effectiveTranscriptPrompt,
  ]) {
    expect(prompt).toContain(escapedAnswer);
    expect(prompt).not.toContain(answers[1]);
    expect(prompt).not.toContain("stale result");
    expect(prompt).not.toContain("unrelated later result");
    expect(prompt).toContain("Handoff payload");
  }
  expect(first.completion).toEqual(storedCompletion);
  expect(second.delivery?.status).toBe("pending");
  const firstLease = firstTurn.setLeasedSteering.mock.calls[0]?.[0];
  expect(firstLease).toMatchObject({
    runIds: [first.runId],
    leaseId: "steering-first-turn:agent-steering",
  });
  if (!firstLease) {
    throw new Error("expected first requester steering lease");
  }
  expect(api.ackPendingAgentSteeringItems(firstLease)).toBe(1);
  expect(first.delivery?.status).toBe("delivered");
  expect(second.delivery?.status).toBe("pending");

  const secondTurn = await assembleWithCapturedHookCtx("steering-second-turn", {
    sessionKey: requesterSessionKey,
  });
  for (const prompt of [
    secondTurn.prompt.effectivePrompt,
    secondTurn.prompt.effectiveTranscriptPrompt,
  ]) {
    expect(prompt).toContain(answers[1]);
    expect(prompt).not.toContain("required first tail");
  }
  const secondLease = secondTurn.setLeasedSteering.mock.calls[0]?.[0];
  expect(secondLease).toMatchObject({ runIds: [second.runId] });
  if (!secondLease) {
    throw new Error("expected second requester steering lease");
  }
  expect(api.ackPendingAgentSteeringItems(secondLease)).toBe(1);
  expect(second.delivery?.status).toBe("delivered");
  expect(first.completion).toEqual(storedCompletion);
});
