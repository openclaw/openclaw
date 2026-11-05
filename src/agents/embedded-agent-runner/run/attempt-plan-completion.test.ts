import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProgressCardPutResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { Context, Model } from "../../../llm/types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { createReplyOperation, type ReplyOperation } from "../../../sessions/session-controller.js";
import { createOpenClawCodingToolsInternal } from "../../agent-tools.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import * as gatewayTool from "../../tools/in-process-gateway.js";
import { createProgressCardTool } from "../../tools/progress-card-tool.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "../runs.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";

registerAgentSessionLoopTestLifecycle();
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
): ProgressCardPutResult {
  return { card: { sessionKey: "agent:main:main", steps, revision: 1, updatedAt: 1 } };
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
    const completionCheck = { unfinishedPlan: false, checked: false };
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Publish repair", status: "completed" as const },
      { step: "Repair remaining failure", status: "pending" as const },
    ];
    using gatewayCall = vi
      .spyOn(gatewayTool, "callInProcessGatewayTool")
      .mockResolvedValue(cardWith(plan));
    const progress = createOpenClawCodingToolsInternal({
      agentId: "main",
      sessionKey: "agent:main:main",
      config: {
        plugins: { enabled: false },
        tools: { allow: ["progress_card"], toolSearch: false },
      },
      onProgressCardPlanSaved: (unfinished) => {
        completionCheck.unfinishedPlan = unfinished;
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
            JSON.stringify(message.content).includes("latest successfully saved plan"),
        );
        expect(check).toBeDefined();
        expect(JSON.stringify(check?.content)).toContain(SILENT_REPLY_TOKEN);
        return respond(model, [toolCall("remaining-repair", "repair")], "toolUse");
      },
      "Both repairs verified.",
    );

    await session.prompt("Repair both failures and verify them.");
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

it.each(["no pending plan", "consumed check", "optional status", "authored silence"])(
  "does not continue after %s",
  async (state) => {
    const completionCheck = {
      unfinishedPlan: state !== "no pending plan",
      checked: state === "consumed check",
    };
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
  },
);

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
  const completionCheck = { unfinishedPlan: false, checked: false };
  const plan = [{ step: "Remaining repair", status: "pending" as const }];
  vi.spyOn(gatewayTool, "callInProcessGatewayTool").mockResolvedValue(cardWith(plan));
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
    onPlanSaved: (unfinished) => {
      completionCheck.unfinishedPlan = unfinished;
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

  await session.prompt("Repair the remaining failure.");
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
