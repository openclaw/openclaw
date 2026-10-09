// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/hook-before-agent-start.types.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createSubagentRunRecord,
  markPendingFinalDelivery,
} from "../../subagent-test-fixtures.test-helpers.js";
import { testing as announceTesting } from "../../subagents/announce/subagent-announce-output.test-support.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../../subagents/registry/subagent-lifecycle-events.js";
import {
  createLifecycleControllerFixture,
  installLifecycleWorkerAckFixture,
} from "../../subagents/registry/subagent-registry-lifecycle-controller.test-support.js";
import { mutateSubagentRuns } from "../../subagents/registry/subagent-registry-persistence.js";
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
vi.mock("../../subagents/registry/subagent-registry-terminal-effects.js", () => ({
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
    requiresToolAuthority?: true;
  } = {},
  assembly: {
    preparedUserTurnMessage?: PersistedUserTurnMessage;
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
  const capturedEvents: PluginHookBeforePromptBuildEvent[] = [];
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        requiresToolAuthority: promptPolicy.requiresToolAuthority,
        handler: async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
          capturedEvents.push(event);
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
    ...(assembly.preparedUserTurnMessage
      ? { preparedUserTurnMessage: assembly.preparedUserTurnMessage }
      : {}),
    sessionAgentId: "main",
    runtimeModel: testModel.id,
    systemPromptText: "Base system prompt",
    runAbortSignal: new AbortController().signal,
    applyPromptBuildToolsAllow: promptPolicy.applyPromptBuildToolsAllow ?? (() => []),
    prepareSystemPrompt: promptPolicy.prepareSystemPrompt,
    setActiveSessionSystemPrompt: setSystemPrompt,
    setLeasedSteering,
  });
  expect(session.messages).toEqual(priorMessages);
  return { captured, capturedEvents, prompt, setLeasedSteering, setSystemPrompt };
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

  it.each([
    { requiresToolAuthority: undefined, reason: "ineligible" },
    { requiresToolAuthority: true, reason: "pending-action-context" },
  ] as const)(
    "gates semantic prefilter admission for authority=$requiresToolAuthority",
    async ({ requiresToolAuthority, reason }) => {
      const { prompt } = await assembleWithCapturedHookCtx(
        "hook-prefilter-admission",
        { supportsTurnScopedToolRestrictions: true },
        { requiresToolAuthority, hookResult: { appendContext: "Answer warmly without tools." } },
      );
      expect(prompt.decisionPrefilter).toMatchObject({
        shouldPruneTools: false,
        status: "skipped",
        reason,
      });
    },
  );

  it.each([
    undefined,
    {
      kind: "inter_session",
      sourceSessionKey: "agent:main:session-a",
      sourceTool: "sessions_send",
    },
  ] as const)("carries typed provenance into the prompt hook: %j", async (inputProvenance) => {
    const { captured } = await assembleWithCapturedHookCtx("provenance-hook-turn", {
      inputProvenance,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ trigger: "user", inputProvenance });
  });
});

describe("prompt-build hook current-input identity", () => {
  it("binds the recorder-owned admitted request to the hook event", async () => {
    const preparedUserTurnMessage: PersistedUserTurnMessage = {
      role: "user",
      content: "Handoff payload",
      timestamp: 1,
      idempotencyKey: "run-admitted:user",
    };
    const { capturedEvents } = await assembleWithCapturedHookCtx(
      "current-input-admitted-request",
      undefined,
      {},
      { preparedUserTurnMessage },
    );

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({
      currentUserMessage: "Handoff payload",
      currentUserMessageId: "run-admitted:user",
    });
  });

  it("keeps an admitted request without text instead of reusing the projected prompt", async () => {
    const preparedUserTurnMessage: PersistedUserTurnMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "synthetic-image" }],
      timestamp: 1,
      idempotencyKey: "run-image-only:user",
    };
    const { capturedEvents } = await assembleWithCapturedHookCtx(
      "current-input-text-free-admitted-request",
      undefined,
      {},
      { preparedUserTurnMessage },
    );

    expect(capturedEvents[0]?.prompt).toBe("Handoff payload");
    expect(capturedEvents[0]).toMatchObject({
      currentUserMessage: "",
      currentUserMessageId: "run-image-only:user",
    });
  });

  it("keeps the legacy identity-free event when no request was admitted", async () => {
    const { capturedEvents } = await assembleWithCapturedHookCtx("current-input-legacy-producer");

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({ prompt: "Handoff payload", messages: [] });
    expect(capturedEvents[0]).not.toHaveProperty("currentUserMessage");
    expect(capturedEvents[0]).not.toHaveProperty("currentUserMessageId");
  });
});

it("injects complete lifecycle results into requester prompts and acknowledges one whole item", async () => {
  const requesterSessionKey = "agent:main:steering-requester";
  const answers = [`${"<result>".repeat(2_100)}required first tail`, "later child result"];
  const children: SubagentRunRecord[] = answers.map((_answer, index) =>
    createSubagentRunRecord({
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
    }),
  );
  const runs = new Map<string, SubagentRunRecord>();
  installLifecycleWorkerAckFixture(runs);
  await mutateSubagentRuns(
    children.map((child) => child.runId),
    () => ({
      value: undefined,
      postimages: new Map(children.map((child) => [child.runId, structuredClone(child)])),
    }),
    { runs },
  );
  const initial = children[0];
  if (!initial) {
    throw new Error("expected registered children");
  }
  const controller = createLifecycleControllerFixture(
    {
      entry: initial,
      runs,
      captureSubagentCompletionReply: vi.fn(async () => {
        throw new Error("producer evidence must own stored completion");
      }),
    },
    {
      callGateway: vi.fn(async () => {
        throw new Error("unexpected Gateway call");
      }),
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ownersByEntry: new Map(),
    },
  );
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
    await mutateSubagentRuns(
      [child.runId],
      (rows) => {
        const current = rows.get(child.runId);
        if (!current) {
          throw new Error("expected completed child");
        }
        const draft = structuredClone(current);
        markPendingFinalDelivery({ entry: draft });
        return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
      },
      { runs },
    );
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
  expect(runs.get(first.runId)?.completion?.resultText).toHaveLength(4_096);
  const storedCompletion = structuredClone(runs.get(first.runId)?.completion);
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
    restoreOnce: vi.fn(async () => {}),
    startAnnounceCleanup: vi.fn(() => false),
    settleRequesterTurn: controller.settleRequesterTurnAfterSessionSpawns,
    markRequesterYielded: controller.markRequesterTurnYielded,
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
  expect(runs.get(first.runId)?.completion).toEqual(storedCompletion);
  expect(runs.get(second.runId)?.delivery?.status).toBe("pending");
  const firstLease = firstTurn.setLeasedSteering.mock.calls[0]?.[0];
  expect(firstLease).toMatchObject({
    runIds: [first.runId],
    leaseId: "steering-first-turn:agent-steering",
  });
  if (!firstLease) {
    throw new Error("expected first requester steering lease");
  }
  expect(await api.ackPendingAgentSteeringItems(firstLease)).toBe(1);
  expect(runs.get(first.runId)?.delivery?.status).toBe("delivered");
  expect(runs.get(second.runId)?.delivery?.status).toBe("pending");

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
  expect(await api.ackPendingAgentSteeringItems(secondLease)).toBe(1);
  expect(runs.get(second.runId)?.delivery?.status).toBe("delivered");
  expect(runs.get(first.runId)?.completion).toEqual(storedCompletion);
});
