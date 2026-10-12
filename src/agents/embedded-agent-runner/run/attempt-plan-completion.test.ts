import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import type { ProgressCardPutResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { Context, Model } from "../../../llm/types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
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
import { clearActiveEmbeddedRun } from "../runs.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

registerAgentSessionLoopTestLifecycle();
const streams: ReturnType<typeof prepareCatalogExecutor>[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) {
    stream.subscription.unsubscribe();
    clearActiveEmbeddedRun("session-output-schema", stream.queueHandle, "agent:main:main");
  }
});

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
    const committed: ProgressCardPutResult = {
      card: { sessionKey: "agent:main:main", steps: plan, revision: 1, updatedAt: 1 },
    };
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
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      attempt,
      onAgentEvent: (event) => events.push(event),
      streamReplies: !nonStreamedMedia,
      trustedLocalMediaToolNames: new Set(["repair"]),
    });
    streams.push(prepared);
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests += 1;
      if (requests === 1) {
        return createAssistantResultStream(
          createAssistant(
            model,
            [
              { type: "toolCall", id: "first-repair", name: "repair", arguments: {} },
              {
                type: "toolCall",
                id: "save-plan",
                name: nested ? "exec" : "progress_card",
                arguments: { plan },
              },
            ],
            "toolUse",
          ),
        );
      }
      if (requests === 2) {
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "Stopped: one repair remains." }]),
        );
      }
      if (requests === 3) {
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
        return createAssistantResultStream(
          createAssistant(
            model,
            [{ type: "toolCall", id: "remaining-repair", name: "repair", arguments: {} }],
            "toolUse",
          ),
        );
      }
      return createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Both repairs verified." }]),
      );
    });

    await session.prompt("Repair both failures and verify them.");
    await prepared.subscription.waitForPendingEvents();

    expect(repair.mock.calls.map(([id]) => id)).toEqual(["first-repair", "remaining-repair"]);
    expect(requests).toBe(4);
    expect(gatewayCall).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.stream === "lifecycle" && event.data.phase === "end"),
    ).toHaveLength(1);
    const assistant = prepared.subscription.getCurrentAttemptAssistant();
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: prepared.subscription.assistantTexts,
      answerSegments: prepared.subscription.answerSegments,
      lastAssistant: assistant,
      currentAssistant: assistant ?? null,
      sessionKey: "agent:main:main",
    });
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
  const progress = createProgressCardTool({
    agentSessionKey: "agent:main:main",
    callGateway: vi.fn().mockResolvedValue({
      card: { sessionKey: "agent:main:main", steps: plan, revision: 1, updatedAt: 1 },
    }),
    onPlanSaved: (unfinished) => {
      completionCheck.unfinishedPlan = unfinished;
    },
  });
  const { session } = await createTestSession({ customTools: [progress] });
  const prepared = prepareCatalogExecutor({ activeSession: session, attempt: { completionCheck } });
  streams.push(prepared);
  const answer = "Files: big.log (9 KB), notes.md (1 KB). May I delete big.log?";
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    requests += 1;
    if (requests === 1) {
      return createAssistantResultStream(
        createAssistant(
          model,
          [{ type: "toolCall", id: "save", name: "progress_card", arguments: { plan } }],
          "toolUse",
        ),
      );
    }
    if (requests === 2) {
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: answer }]));
    }
    // Stand-in for the live model: it restates the blocker unless the check offers silence.
    const check = JSON.stringify(context.messages.at(-1)?.content);
    expect(check).toContain("latest successfully saved plan");
    return createAssistantResultStream(
      createAssistant(model, [
        {
          type: "text",
          text: check.includes(SILENT_REPLY_TOKEN)
            ? SILENT_REPLY_TOKEN
            : "Deleting big.log still needs your approval.",
        },
      ]),
    );
  });

  await session.prompt("List the files, then ask me before deleting the largest one.");
  await prepared.subscription.waitForPendingEvents();

  expect(requests).toBe(3);
  const assistant = prepared.subscription.getCurrentAttemptAssistant();
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: prepared.subscription.assistantTexts,
    answerSegments: prepared.subscription.answerSegments,
    lastAssistant: assistant,
    currentAssistant: assistant ?? null,
    keptAnswer: prepared.subscription.getKeptAnswer(),
    sessionKey: "agent:main:main",
  });
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
])("honors $name", async ({ replacement, checks }) => {
  const completionCheck = { unfinishedPlan: false, checked: replacement === "recovery" };
  const pending = [{ step: "Await external permission", status: "pending" as const }];
  const initial = {
    card: { sessionKey: "agent:main:main", steps: pending, revision: 1, updatedAt: 1 },
  };
  const gateway = vi.fn().mockResolvedValue(initial);
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
  const progress = createProgressCardTool({
    agentSessionKey: "agent:main:main",
    callGateway: gateway,
    onPlanSaved: (unfinished) => {
      completionCheck.unfinishedPlan = unfinished;
    },
  });
  const { session } = await createTestSession({ customTools: [progress] });
  const prepared = prepareCatalogExecutor({
    activeSession: session,
    attempt: {
      completionCheck,
      ...(replacement === "status"
        ? { silentExpected: true, terminalReplyExpectation: "optional" as const }
        : {}),
    },
  });
  streams.push(prepared);
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((model: Model) => {
    requests += 1;
    return createAssistantResultStream(
      createAssistant(
        model,
        requests <= writes
          ? [
              {
                type: "toolCall",
                id: "save-" + requests,
                name: "progress_card",
                arguments: requests === 1 ? { plan: pending } : replacementArgs,
              },
            ]
          : [
              {
                type: "text",
                text: "Waiting for the user's permission; no more authorized actions.",
              },
            ],
        requests <= writes ? "toolUse" : "stop",
      ),
    );
  });
  await session.prompt("Investigate the failure, but do not proceed without permission.");
  await prepared.subscription.waitForPendingEvents();
  expect(requests).toBe(writes + 1 + checks);
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
  { owner: "side-effecting hook revision", checks: 0 },
])("preserves $owner policy with $checks completion checks", async ({ owner, checks }) => {
  const completionCheck = { unfinishedPlan: false, checked: false };
  const plan = [{ step: "Remaining repair", status: "pending" as const }];
  const progress = createProgressCardTool({
    agentSessionKey: "agent:main:main",
    callGateway: vi.fn().mockResolvedValue({
      card: { sessionKey: "agent:main:main", steps: plan, revision: 1, updatedAt: 1 },
    }),
    onPlanSaved: (unfinished) => {
      completionCheck.unfinishedPlan = unfinished;
    },
  });
  const { session } = await createTestSession({ customTools: [progress] });
  const controller = new AbortController();
  let requests = 0;
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
  const prepared = prepareCatalogExecutor({
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
      timedOut: owner === "timed out" && requests > 1,
      yieldDetected: owner === "yielded" && requests > 1,
      promptError: undefined,
    }),
  });
  streams.push(prepared);
  streamMocks.streamSimple.mockImplementation((model: Model) => {
    requests += 1;
    if (requests > 1 && owner === "cancelled") {
      controller.abort();
    }
    const assistant = createAssistant(
      model,
      requests === 1
        ? [{ type: "toolCall", id: "save", name: "progress_card", arguments: { plan } }]
        : [{ type: "text", text: "The owner stopped this work." }],
      requests === 1 ? "toolUse" : owner === "output limited" ? "length" : "stop",
    );
    if (requests > 1 && owner === "provider refusal") {
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
  await session.prompt("Repair the remaining failure.");
  await prepared.subscription.waitForPendingEvents();
  expect(requests).toBe(2 + checks);
  expect(completionCheck.checked).toBe(checks > 0);
  if (owner === "hook budget exhausted") {
    expect(onFinalize).not.toHaveBeenCalled();
  }
  if (owner === "side-effecting hook revision") {
    expect(prepared.getBeforeAgentFinalizeRevisionReason()).toContain("Check the remaining work");
    expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toEqual(expect.any(String));
    expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
  }
  if (checks > 0) {
    expect(prepared.getBeforeAgentFinalizeRevisionReason()).toBeUndefined();
    expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
  }
});
