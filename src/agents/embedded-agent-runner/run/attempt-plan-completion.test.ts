import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeInternalNativeInvocation } from "../../../../packages/agent-core/src/internal-hooks.js";
import type { ProgressCardPutResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { progressCardStore } from "../../../gateway/progress-card-store.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { Context, Model } from "../../../llm/types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { createReplyOperation, type ReplyOperation } from "../../../sessions/session-controller.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createOpenClawCodingToolsInternal } from "../../agent-tools.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import * as gatewayTool from "../../tools/in-process-gateway.js";
import { createProgressCardTool } from "../../tools/progress-card-tool.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "../runs.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { captureProgressWorkReader } from "./progress-work.js";
import type { EmbeddedRunCompletionCheck } from "./terminal-retry-state.js";

registerAgentSessionLoopTestLifecycle();
const workOwner = {
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "session-output-schema",
  lifecycleRevision: null,
};
const runWithCaller = <T>(run: () => Promise<T>) =>
  withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: { runId: "test", instanceId: "test" },
      receiptAuthority: () => true,
    },
    run,
  );
const streams: ReturnType<typeof prepareCatalogExecutor>[] = [];
let replyOperation: ReplyOperation;
beforeEach(() => {
  replyOperation = createReplyOperation({
    sessionId: "session-output-schema",
    sessionKey: "agent:main:main",
    resetTriggered: false,
  });
});
afterEach(() => {
  for (const stream of streams.splice(0)) {
    stream.subscription.unsubscribe();
    clearActiveEmbeddedRun("session-output-schema", stream.queueHandle, "agent:main:main");
  }
  replyOperation.complete();
  vi.restoreAllMocks();
});

function respond(...args: Parameters<typeof createAssistant>) {
  return createAssistantResultStream(createAssistant(...args));
}
type Turn = (model: Model, context: Context, request: number) => ReturnType<typeof respond>;
type ScriptedTurn = string | ReturnType<typeof toolCall>[] | Turn;
function mockTurns(...turns: [ScriptedTurn, ...ScriptedTurn[]]) {
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((model, context) => {
    const turn = turns[Math.min(requests++, turns.length - 1)]!;
    return typeof turn === "function"
      ? turn(model, context, requests)
      : respond(model, turn, typeof turn === "string" ? "stop" : "toolUse");
  });
  return () => requests;
}
function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return { type: "toolCall" as const, id, name, arguments: args };
}
function cardWith(
  steps: NonNullable<ProgressCardPutResult["card"]>["steps"],
): ProgressCardPutResult & {
  work: import("../../../session-cards/progress-card-work-intent.js").WorkSnapshot;
} {
  return {
    card: { sessionKey: "agent:main:main", steps, revision: 1, updatedAt: 1 },
    work: {
      kind: "retained",
      coverage: { kind: "covered", basis: "bounded-no-handoff" },
      state: {
        generation: 1,
        revision: 1,
        record: {
          version: 1,
          owner: workOwner,
          source: { runId: "test", turnId: "test", toolCallId: "save", processGeneration: "test" },
          scope: "Repair",
          steps: steps ?? [],
          disposition: { kind: "actionable" },
        },
      },
    },
  };
}

function prepare(options: Parameters<typeof prepareCatalogExecutor>[0]) {
  const prepared = prepareCatalogExecutor({ replyOperation, ...options });
  streams.push(prepared);
  return prepared;
}

function payloadsFor({ subscription }: ReturnType<typeof prepareCatalogExecutor>) {
  const assistant = subscription.getCurrentAttemptAssistant();
  return buildEmbeddedRunPayloads({
    assistantTexts: subscription.assistantTexts,
    answerSegments: subscription.answerSegments,
    lastAssistant: assistant,
    currentAssistant: assistant ?? null,
    sessionKey: "agent:main:main",
  });
}

it.each([
  { nested: false, nonStreamedMedia: false },
  { nested: true, nonStreamedMedia: false },
  { nested: false, nonStreamedMedia: true },
])(
  "continues a committed unfinished plan without repeating completed effects (nested=$nested, nonStreamedMedia=$nonStreamedMedia)",
  async ({ nested, nonStreamedMedia }) => {
    const completionCheck: EmbeddedRunCompletionCheck = { work: { kind: "none" }, checked: false };
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Publish repair", status: "completed" as const },
      { step: "Repair remaining failure", status: "pending" as const },
    ];
    using gatewayCall = vi
      .spyOn(gatewayTool, "callAgentToolGatewayRequest")
      .mockResolvedValue(cardWith(plan));
    const progress = createOpenClawCodingToolsInternal({
      agentId: "main",
      sessionKey: "agent:main:main",
      progressWorkOwner: workOwner,
      progressWorkTarget: captureSessionTranscriptTargetBinding({
        ...workOwner,
        storePath: "/private/test.sqlite",
      }),
      readProgressCardWork: () => completionCheck.work,
      onProgressCardWorkSaved: (snapshot) => {
        completionCheck.work = snapshot;
      },
      config: {
        plugins: { enabled: false },
        tools: { allow: ["progress_card"], toolSearch: false },
      },
    }).find((tool) => tool.name === "progress_card");
    if (!progress) {
      throw new Error("The registered progress-card tool is missing");
    }
    const mediaUrl = "/tmp/completion-repair.ogg";
    const attachment = { path: mediaUrl, mimeType: "audio/ogg", name: "repair.ogg" };
    const media = {
      mediaUrls: [mediaUrl],
      attachments: [attachment],
      audioAsVoice: true,
      trustedLocalMedia: true,
    };
    const expectedPendingMedia = {
      ...media,
      attachments: [{ ...attachment, trustedLocalMedia: true }],
    };
    const repair = vi.fn(async (id: string) => ({
      content: [{ type: "text" as const, text: "Repaired" }],
      details: {
        receipt: id,
        ...(nonStreamedMedia && id === "first-repair" ? { media } : {}),
      },
    }));
    const { session } = await createTestSession({
      customTools: [
        {
          ...progress,
          name: nested ? "exec" : progress.name,
          execute: (id, args, signal, update) =>
            nested
              ? prepared.toolSearchCatalogExecutor({
                  tool: progress,
                  toolName: progress.name,
                  toolCallId: "nested-plan",
                  parentToolCallId: id,
                  source: "openclaw",
                  sourceName: "core",
                  input: args,
                  signal,
                  onUpdate: update,
                  acceptResultBeforeProjection: async (result) => structuredClone(result),
                })
              : progress.execute(id, args, signal, update),
        },
        { ...createStubTool("repair"), execute: repair },
      ],
    });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const prepared = prepare({
      activeSession: session,
      attempt: { completionCheck },
      onAgentEvent: (event) => events.push(event),
      streamReplies: !nonStreamedMedia,
      trustedLocalMediaToolNames: new Set(["repair"]),
    });
    const requests = mockTurns(
      [
        toolCall("first-repair", "repair"),
        toolCall("save-plan", nested ? "exec" : "progress_card", { plan }),
      ],
      "Stopped: one repair remains.",
      (model, context) => {
        if (nonStreamedMedia) {
          expect(prepared.subscription.getPendingToolMediaReply()).toEqual(expectedPendingMedia);
        }
        const check = context.messages.findLast(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("retained task still has unfinished steps"),
        );
        expect(check).toBeDefined();
        expect(JSON.stringify(check?.content)).toContain(SILENT_REPLY_TOKEN);
        return respond(model, [toolCall("remaining-repair", "repair")], "toolUse");
      },
      "Both repairs verified.",
    );

    await runWithCaller(() => session.prompt("Repair both failures and verify them."));
    await prepared.subscription.waitForPendingEvents();

    expect(repair.mock.calls.map(([id]) => id)).toEqual(["first-repair", "remaining-repair"]);
    expect(requests()).toBe(4);
    expect(gatewayCall).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.stream === "lifecycle" && event.data.phase === "end"),
    ).toHaveLength(1);
    const payloads = payloadsFor(prepared);
    expect(payloads.map((payload) => payload.text)).toEqual(["Both repairs verified."]);
    if (nonStreamedMedia) {
      expect(prepared.subscription.getPendingToolMediaReply()).toEqual(expectedPendingMedia);
    }
    expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
  },
);

it("keeps the real finalizer quiet after a same-process preserve-tail reset", async () => {
  await withOpenClawTestState({ label: "reset-finalizer", scenario: "minimal" }, async (state) => {
    const now = Date.now();
    const storePath = state.path("reset-finalizer.sqlite");
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    const target = captureSessionTranscriptTargetBinding({
      ...workOwner,
      storePath,
      expectedLifecycleRevision: "before",
    });
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      lifecycleRevision: "before",
      updatedAt: now,
    });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const source = {
      runId: "before",
      turnId: "before",
      toolCallId: "plan",
      processGeneration: getAgentRunLifecycleGeneration(),
    };
    installSessionToolResultGuard(manager, { runId: source.runId });
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        turnId: source.turnId,
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: source.toolCallId, name: "progress_card", arguments: {} },
        ],
      }),
    );
    const nativeResult = {
      role: "toolResult" as const,
      toolCallId: source.toolCallId,
      toolName: "progress_card",
      content: [{ type: "text" as const, text: "Saved" }],
      isError: false,
      timestamp: 1,
    };
    observeInternalNativeInvocation(nativeResult, {
      ...source,
      toolName: "progress_card",
      qualification: "managed-progress",
    });
    await manager.appendMessageAsync(nativeResult);
    const reader = captureProgressWorkReader({ target, assertCurrent() {} });
    const steps = [{ step: "Finish retained work", status: "pending" as const }];
    await progressCardStore.put(
      target.sessionKey,
      {
        steps,
        workCommand: {
          kind: "begin",
          owner: reader.owner,
          source,
          expected: null,
          scope: "Repair",
        },
      },
      "main",
    );
    expect(await reader.read()).toMatchObject({ coverage: { kind: "covered" } });
    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      resetBoundary: { context: "preserve-tail", reason: "idle", cwd: state.workspaceDir },
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId: target.sessionId,
        lifecycleRevision: "after",
        updatedAt: now + 1,
      }),
    });
    const current = captureProgressWorkReader({
      target: { ...target, expectedLifecycleRevision: "after" },
      assertCurrent() {},
    });
    const completionCheck: EmbeddedRunCompletionCheck = {
      work: await current.read(),
      refresh: () => current.read(),
      checked: false,
    };
    expect(completionCheck.work).toMatchObject({
      kind: "retained",
      state: { record: { steps } },
      coverage: { kind: "unavailable" },
    });
    const { session } = await createTestSession();
    const prepared = prepare({
      activeSession: session,
      attempt: { completionCheck, terminalReplyExpectation: "required" },
    });
    const requests = mockTurns("The retained task needs current reconciliation.");
    await session.prompt("Report the retained task status.");
    await prepared.subscription.waitForPendingEvents();
    expect(requests()).toBe(1);
    expect(
      session.messages.filter(
        (message) =>
          message.role === "custom" && message.customType === "openclaw.plan-completion-check",
      ),
    ).toHaveLength(0);
    expect(await current.read()).toMatchObject({ state: { record: { steps } } });
  });
});

it.each([
  "no pending plan",
  "consumed check",
  "optional status",
  "authored silence",
  "unavailable coverage",
  "persisted waiting",
  "paused work",
  "failed refresh",
])("does not continue after %s", async (state) => {
  const completionCheck: EmbeddedRunCompletionCheck = {
    work:
      state === "no pending plan"
        ? { kind: "none" }
        : cardWith([{ step: "Remaining", status: "pending" }]).work,
    checked: state === "consumed check",
  };
  if (completionCheck.work.kind === "retained") {
    if (state === "unavailable coverage") {
      completionCheck.work.coverage = {
        kind: "unavailable",
        reason: "Lifecycle history unavailable",
      };
    }
    const record = completionCheck.work.state.record!;
    if (state === "persisted waiting") {
      record.disposition = {
        kind: "waiting",
        source: record.source,
        receipt: { kind: "media", runId: "accepted-media", taskId: "task" },
        resumeCondition: "Native delivery",
      };
    }
    if (state === "paused work") {
      record.disposition = {
        kind: "paused-blocked",
        source: record.source,
        reason: "Approval",
        resumeCondition: "User decision",
      };
    }
    if (state === "failed refresh") {
      completionCheck.refresh = async () => ({ kind: "unavailable", reason: "Owner replaced" });
    }
  }
  const { session } = await createTestSession();
  const prepared = prepare({
    activeSession: session,
    attempt: {
      completionCheck,
      ...(state === "optional status"
        ? { silentExpected: true, terminalReplyExpectation: "optional" as const }
        : { terminalReplyExpectation: "required" as const }),
    },
  });
  const requests = mockTurns(state === "authored silence" ? "NO_REPLY" : "Work is complete.");
  await session.prompt("Continue only when work remains.");
  await prepared.subscription.waitForPendingEvents();
  expect(requests()).toBe(1);
  expect(
    session.messages.filter(
      (message) =>
        message.role === "custom" && message.customType === "openclaw.plan-completion-check",
    ),
  ).toHaveLength(0);
});

it.each([
  { owner: "plugin finalize", checks: 0 },
  { owner: "closed during hook", checks: 0 },
  { owner: "cancelled", checks: 0 },
  { owner: "timed out", checks: 0 },
  { owner: "yielded", checks: 0 },
  { owner: "provider refusal", checks: 0 },
  { owner: "output limited", checks: 0 },
  { owner: "hook budget exhausted", checks: 1 },
  { owner: "side-effecting hook revision", checks: 1 },
])("preserves $owner policy with $checks completion checks", async ({ owner, checks }) => {
  const completionCheck: EmbeddedRunCompletionCheck = { work: { kind: "none" }, checked: false };
  const plan = [{ step: "Remaining repair", status: "pending" as const }];
  vi.spyOn(gatewayTool, "callAgentToolGatewayRequest").mockResolvedValue(cardWith(plan));
  const controller = new AbortController();
  const onFinalize = vi.fn(async () => {
    if (owner === "closed during hook") {
      prepared.subscription.unsubscribe();
      return undefined;
    }
    return owner === "side-effecting hook revision"
      ? { action: "revise", reason: "Check the remaining work" }
      : { action: "finalize" };
  });
  const hookRunner =
    owner.includes("hook") || owner === "plugin finalize"
      ? createHookRunner(
          createMockPluginRegistry([{ hookName: "before_agent_finalize", handler: onFinalize }]),
        )
      : undefined;
  const requests = mockTurns([toolCall("save", "progress_card", { plan })], (model) => {
    if (owner === "cancelled") {
      controller.abort();
    }
    const assistant = createAssistant(
      model,
      "The owner stopped this work.",
      owner === "output limited" ? "length" : "stop",
    );
    if (owner === "provider refusal") {
      assistant.diagnostics = [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: model.provider, category: "refusal" },
        },
      ];
    }
    return createAssistantResultStream(assistant);
  });
  const progress = createProgressCardTool({
    agentSessionKey: "agent:main:main",
    workOwner,
    workTarget: captureSessionTranscriptTargetBinding({
      ...workOwner,
      storePath: "/private/test.sqlite",
    }),
    readWork: () => completionCheck.work,
    onWorkSaved: (snapshot) => {
      completionCheck.work = snapshot;
    },
  });
  const { session } = await createTestSession({ customTools: [progress] });
  const prepared = prepare({
    activeSession: session,
    hookRunner,
    runAbortController: controller,
    attempt: {
      completionCheck,
      provider: testModel.provider,
      modelId: testModel.id,
      model: testModel,
      ...(owner === "hook budget exhausted"
        ? { beforeAgentFinalizeRevisionAttempts: 3, maxBeforeAgentFinalizeRevisions: 3 }
        : {}),
    },
    getRunState: () => ({
      aborted: controller.signal.aborted,
      timedOut: owner === "timed out" && requests() > 1,
      yieldDetected: owner === "yielded" && requests() > 1,
      promptError: undefined,
    }),
  });

  await runWithCaller(() => session.prompt("Repair the remaining failure."));
  await prepared.subscription.waitForPendingEvents();
  expect(requests()).toBe(2 + checks);
  expect(completionCheck.checked).toBe(checks > 0);
  if (owner === "hook budget exhausted") {
    expect(onFinalize).not.toHaveBeenCalled();
  }
  if (checks > 0) {
    expect(prepared.getBeforeAgentFinalizeRevisionReason()).toBeUndefined();
    expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
  }
});
