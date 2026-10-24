import { Type } from "typebox";
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
import * as gatewayTool from "../../tools/in-process-gateway.js";
import { createProgressCardTool } from "../../tools/progress-card-tool.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "../runs.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import type { EmbeddedRunCompletionCheck } from "./terminal-retry-state.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

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

async function planSession(
  completionCheck: EmbeddedRunCompletionCheck,
  options: Parameters<typeof prepareCatalogExecutor>[0] = {},
) {
  const progress = createProgressCardTool({
    agentSessionKey: "agent:main:main",
    onPlanSaved: (unfinished) => {
      completionCheck.unfinishedPlan = unfinished;
    },
  });
  const { session } = await createTestSession({ customTools: [progress] });
  return {
    session,
    prepared: prepare({ activeSession: session, attempt: { completionCheck }, ...options }),
  };
}

function payloadsFor({ subscription }: ReturnType<typeof prepareCatalogExecutor>, keep = false) {
  const assistant = subscription.getCurrentAttemptAssistant();
  return buildEmbeddedRunPayloads({
    assistantTexts: subscription.assistantTexts,
    answerSegments: subscription.answerSegments,
    lastAssistant: assistant,
    currentAssistant: assistant ?? null,
    ...(keep ? { keptAnswer: subscription.getKeptAnswer() } : {}),
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
    const committed: ProgressCardPutResult = cardWith(plan);
    using gatewayCall = vi
      .spyOn(gatewayTool, "callInProcessGatewayTool")
      .mockResolvedValue(committed);
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
        {
          name: "repair",
          label: "Repair",
          description: "Repair one failure",
          parameters: Type.Object({}),
          execute: repair,
        },
      ],
    });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const attempt = { completionCheck };
    const prepared = prepare({
      activeSession: session,
      attempt,
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
        expect(
          context.messages.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("latest successfully saved plan"),
          ),
        ).toBe(true);
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
      const pendingMedia = prepared.subscription.getPendingToolMediaReply();
      expect(pendingMedia).toEqual(expectedPendingMedia);
      expect(
        mergeAttemptToolMediaPayloads({
          payloads,
          toolMediaUrls: pendingMedia?.mediaUrls,
          toolAudioAsVoice: pendingMedia?.audioAsVoice,
          toolTrustedLocalMedia: pendingMedia?.trustedLocalMedia,
        }),
      ).toMatchObject([
        {
          text: "Both repairs verified.",
          mediaUrl,
          mediaUrls: [mediaUrl],
          audioAsVoice: true,
          trustedLocalMedia: true,
        },
      ]);
    }
    expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
  },
);

it("keeps a reply that already reports the blocker as the only reply after the check", async () => {
  const completionCheck = { unfinishedPlan: false, checked: false };
  const plan = [
    { step: "List files", status: "completed" as const },
    { step: "Delete the largest file", status: "pending" as const },
  ];
  vi.spyOn(gatewayTool, "callInProcessGatewayTool").mockResolvedValue(cardWith(plan));
  const { session, prepared } = await planSession(completionCheck);
  const answer = "Files: big.log (9 KB), notes.md (1 KB). May I delete big.log?";
  const requests = mockTurns(
    [toolCall("save", "progress_card", { plan })],
    answer,
    (model, context) => {
      // Stand-in for the live model: it restates the blocker unless the check offers silence.
      const check = JSON.stringify(context.messages.at(-1)?.content);
      expect(check).toContain("latest successfully saved plan");
      return respond(
        model,
        check.includes(SILENT_REPLY_TOKEN)
          ? SILENT_REPLY_TOKEN
          : "Deleting big.log still needs your approval.",
      );
    },
  );

  await session.prompt("List the files, then ask me before deleting the largest one.");
  await prepared.subscription.waitForPendingEvents();

  expect(requests()).toBe(3);
  const payloads = payloadsFor(prepared, true);
  expect(payloads.map((payload) => payload.text)).toEqual([answer]);
});

it.each([
  { name: "completed replacement", replacement: "completed", checks: 0 },
  { name: "cleared replacement", replacement: "clear", checks: 0 },
  { name: "note-only replacement", replacement: "note", checks: 0 },
  { name: "failed replacement retains pending work", replacement: "failed", checks: 1 },
  { name: "genuine blocker gets one check", replacement: "pending", checks: 1 },
  { name: "no plan saved in this run", replacement: "untouched", checks: 0 },
  { name: "a consumed check is not rearmed by another save", replacement: "recovery", checks: 0 },
  { name: "status-only refresh", replacement: "status", checks: 0 },
  { name: "authored silence with pending work", replacement: "silent", checks: 0 },
])("honors $name", async ({ replacement, checks }) => {
  const completionCheck = { unfinishedPlan: false, checked: replacement === "recovery" };
  const pending = [{ step: "Await external permission", status: "pending" as const }];
  const initial = cardWith(pending);
  const gateway = vi.spyOn(gatewayTool, "callInProcessGatewayTool").mockResolvedValue(initial);
  const replacementArgs =
    replacement === "completed"
      ? { plan: [{ step: "Await external permission", status: "completed" }] }
      : replacement === "clear"
        ? {}
        : { markdown: "Paused awaiting permission." };
  const writes = ["completed", "clear", "note", "failed"].includes(replacement)
    ? 2
    : replacement === "untouched"
      ? 0
      : 1;
  if (writes === 2) {
    gateway.mockResolvedValueOnce(initial);
    if (replacement === "failed") {
      gateway.mockRejectedValueOnce(new Error("Save rejected"));
    } else {
      gateway.mockResolvedValueOnce({
        card:
          replacement === "clear"
            ? null
            : {
                sessionKey: "agent:main:main",
                revision: 2,
                updatedAt: 2,
                ...(replacement === "completed"
                  ? { steps: [{ step: "Await external permission", status: "completed" }] }
                  : { markdown: "Paused awaiting permission." }),
              },
      });
    }
  }
  const { session, prepared } = await planSession(completionCheck, {
    attempt: {
      completionCheck,
      ...(replacement === "status"
        ? { silentExpected: true, terminalReplyExpectation: "optional" as const }
        : { terminalReplyExpectation: "required" as const }),
    },
  });
  const requests = mockTurns((model, _context, request) => {
    return respond(
      model,
      request <= writes
        ? [
            toolCall(
              "save-" + request,
              "progress_card",
              request === 1 ? { plan: pending } : replacementArgs,
            ),
          ]
        : replacement === "silent"
          ? "NO_REPLY"
          : "Waiting for the user's permission; no more authorized actions.",
      request <= writes ? "toolUse" : "stop",
    );
  });
  await session.prompt("Investigate the failure, but do not proceed without permission.");
  await prepared.subscription.waitForPendingEvents();
  expect(requests()).toBe(writes + 1 + checks);
  expect(
    session.messages.filter(
      (message) =>
        message.role === "custom" && message.customType === "openclaw.plan-completion-check",
    ),
  ).toHaveLength(checks);
  expect(gateway).toHaveBeenCalledTimes(writes);
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
  const requests = mockTurns((model, _context, request) => {
    if (request > 1 && owner === "cancelled") {
      controller.abort();
    }
    const assistant = createAssistant(
      model,
      request === 1
        ? [toolCall("save", "progress_card", { plan })]
        : "The owner stopped this work.",
      request === 1 ? "toolUse" : owner === "output limited" ? "length" : "stop",
    );
    if (request > 1 && owner === "provider refusal") {
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
  const { session, prepared } = await planSession(completionCheck, {
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
