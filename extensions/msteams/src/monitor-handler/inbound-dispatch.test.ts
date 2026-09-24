import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { admitMSTeamsMessage } from "./access.js";
import { dispatchMSTeamsInboundTurn } from "./inbound-dispatch.js";
import { assembleMSTeamsInboundFacts, prepareMSTeamsDebounceEntry } from "./inbound-facts.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";
import { prepareMSTeamsThreadRouting } from "./thread-context.js";

const { dispatchReplyFromConfig, deliver, onIdle, onFinalize } = getRuntimeApiMockState();

async function createDirectTurn(turnAdoptionLifecycle?: MSTeamsIngressLifecycle) {
  const { deps } = createMessageHandlerDeps({
    channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
  });
  const context: MSTeamsTurnContext = {
    activity: buildChannelActivity({
      conversation: { id: "dm-conversation", conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
    sendActivity: vi.fn(async () => ({ id: "warning" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
  const facts = assembleMSTeamsInboundFacts(
    await prepareMSTeamsDebounceEntry({ context, turnAdoptionLifecycle }),
  );
  const logVerboseMessage = vi.fn();
  const admission = await admitMSTeamsMessage({ ...deps, ...facts, logVerboseMessage });
  if (!admission) {
    throw new Error("expected admitted direct message fixture");
  }
  return {
    ...deps,
    facts,
    admission,
    routing: prepareMSTeamsThreadRouting({ ...deps, ...facts, ...admission }),
    content: { agentBody: facts.rawBody, inboundMedia: [] },
    thread: {
      teamAadGroupId: undefined,
      quoteBodyFull: undefined,
      quoteSenderId: undefined,
      quoteSenderName: undefined,
      threadContext: [],
    },
    replyStyle: "thread",
    logVerboseMessage,
    contextVisibilityMode: "all",
    mentionWasEffective: true,
    conversationHistories: new Map(),
    historyLimit: 0,
  } satisfies Parameters<typeof dispatchMSTeamsInboundTurn>[0];
}

describe("Teams inbound dispatch through the core turn runner", () => {
  it.each([
    { send: false, visible: false, finalResponses: 0 },
    { send: true, visible: false, finalResponses: 0 },
    { send: true, visible: true, finalResponses: 1 },
  ])(
    "reports settled final responses for send=$send/visible=$visible",
    async ({ send, visible, finalResponses }) => {
      const turn = await createDirectTurn();
      deliver.mockResolvedValueOnce({
        visibleReplySent: visible,
        ...(visible ? { messageIds: ["reply-1"] } : {}),
      });
      if (send) {
        dispatchReplyFromConfig.mockImplementationOnce(async ({ dispatcher }) => ({
          queuedFinal: dispatcher.sendFinalReply({ text: "reply" }),
          counts: dispatcher.getQueuedCounts(),
        }));
      }

      await expect(dispatchMSTeamsInboundTurn(turn)).resolves.toEqual({
        kind: "completed",
        finalResponses,
      });
      expect(deliver).toHaveBeenCalledTimes(send ? 1 : 0);
      expect(turn.log.info).toHaveBeenCalledWith("dispatch complete", {
        counts: { tool: 0, block: 0, final: finalResponses },
      });
    },
  );

  it("waits for the delivery owner's final receipt before completing", async () => {
    const turn = await createDirectTurn();
    const sendDrained = createDeferred<void>();
    const finalized = createDeferred<void>();
    const finalization = createDeferred<{ visibleReplySent: true; messageIds: string[] }>();
    const events: string[] = [];
    let waitForIdle: (() => Promise<unknown>) | undefined;
    onIdle.mockImplementationOnce(() => sendDrained.resolve());
    onFinalize.mockImplementationOnce(() => {
      events.push("terminal");
      finalized.resolve();
    });
    deliver.mockResolvedValueOnce({ visibleReplySent: false, finalization: finalization.promise });
    dispatchReplyFromConfig.mockImplementationOnce(async ({ dispatcher }) => {
      waitForIdle = dispatcher.waitForIdle.bind(dispatcher);
      return {
        queuedFinal: dispatcher.sendFinalReply({ text: "deferred reply" }),
        counts: dispatcher.getQueuedCounts(),
      };
    });
    let settled = false;
    const result = dispatchMSTeamsInboundTurn(turn).then((value) => {
      settled = true;
      return value;
    });
    let joined: PromiseSettledResult<unknown>[];
    try {
      await Promise.race([sendDrained.promise, finalized.promise, result]);
      // Sends have drained; let ready continuations expose premature core completion.
      await setImmediate();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onIdle).toHaveBeenCalledTimes(1);
      expect(onFinalize).not.toHaveBeenCalled();
      expect(turn.log.info).not.toHaveBeenCalledWith("dispatch complete", expect.anything());
      expect(settled).toBe(false);
    } finally {
      events.push("release");
      finalization.resolve({ visibleReplySent: true, messageIds: ["settled-reply"] });
      joined = await Promise.allSettled([result, waitForIdle?.()]);
    }
    for (const outcome of joined) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    await expect(result).resolves.toEqual({ kind: "completed", finalResponses: 1 });
    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["release", "terminal"]);
  });

  it.each([false, true])(
    "reports a legacy failure when the warning rejects=%s",
    async (warningRejects) => {
      const turn = await createDirectTurn();
      const error = new Error("agent dispatch failed");
      dispatchReplyFromConfig.mockRejectedValueOnce(error);
      if (warningRejects) {
        vi.mocked(turn.facts.context.sendActivity).mockRejectedValueOnce(
          new Error("warning failed"),
        );
      }

      await expect(dispatchMSTeamsInboundTurn(turn)).resolves.toEqual({ kind: "failed" });
      expect(turn.facts.context.sendActivity).toHaveBeenCalledExactlyOnceWith(
        "⚠️ Something went wrong. Please try again.",
      );
      expect(turn.runtime.error).toHaveBeenCalledWith(
        "msteams dispatch failed: agent dispatch failed",
      );
    },
  );

  it("forwards claim ownership and rethrows durable failures without a legacy warning", async () => {
    const lifecycle: MSTeamsIngressLifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const turn = await createDirectTurn(lifecycle);
    const error = new Error("retry this durable turn");
    dispatchReplyFromConfig.mockRejectedValueOnce(error);

    await expect(dispatchMSTeamsInboundTurn(turn)).rejects.toBe(error);
    const forwarded =
      dispatchReplyFromConfig.mock.calls[0]?.[0].replyOptions?.turnAdoptionLifecycle;
    expect(forwarded).toMatchObject({ admission: "exclusive", abortSignal: lifecycle.abortSignal });
    expect(forwarded?.onAdopted).toBe(lifecycle.onAdopted);
    expect(forwarded?.onDeferred).toBe(lifecycle.onDeferred);
    expect(forwarded?.onAbandoned).toBe(lifecycle.onAbandoned);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
    expect(turn.facts.context.sendActivity).not.toHaveBeenCalled();
  });
});
