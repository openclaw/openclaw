import { shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
// Matrix tests cover the handler's reply presentation wiring.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").sendMessageMatrix>(),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "$draft1", roomId: "!room" })),
);
const reactMatrixMessageMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: vi.fn((text: string) => ({
    trimmedText: text.trim(),
    convertedText: text.trim(),
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
  })),
  reactMatrixMessage: reactMatrixMessageMock,
  resolveMatrixMentionsForBody: vi.fn(async () => ({})),
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: vi.fn(async () => {}),
}));

type DeliverFn = (
  payload: ReplyPayload,
  info: { kind: "tool" | "block" | "final" },
) => Promise<unknown>;

beforeEach(() => {
  installMatrixMonitorTestRuntime();
  sendMessageMatrixMock.mockReset().mockImplementation(async (_room, text, options) => {
    const result = {
      messageId: "$reply1",
      primaryMessageId: "$reply1",
      roomId: "!room",
      receipt: {
        primaryPlatformMessageId: "$reply1",
        platformMessageIds: ["$reply1"],
        parts: [{ platformMessageId: "$reply1", kind: "text" as const, index: 0 }],
        sentAt: 1,
      },
      content: text ?? "",
    };
    await options.onDeliveryResult?.(result);
    return result;
  });
  editMessageMatrixMock.mockClear();
  sendSingleTextMessageMatrixMock.mockClear();
  reactMatrixMessageMock.mockClear();
});

describe("matrix monitor handler reply presentation", () => {
  it.each([undefined] as const)(
    "applies current acknowledgement scope while preserving account override %s",
    async (accountScope) => {
      const cfg: CoreConfig = {
        messages: { ackReaction: "👀", ackReactionScope: "off" },
        channels: {
          matrix: {
            dm: { allowFrom: ["*"] },
            accounts: { ops: { ackReactionScope: accountScope } },
          },
        },
      };
      let currentConfig = cfg;
      const dispatchInboundMessage = vi.fn(async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }));
      const { handler } = createMatrixHandlerTestHarness({
        cfg,
        currentConfig: () => currentConfig,
        shouldAckReaction,
        dispatchInboundMessage,
      });
      for (const [index, scope] of (["off", "all", "off"] as const).entries()) {
        currentConfig = { ...cfg, messages: { ...cfg.messages, ackReactionScope: scope } };
        const eventId = `$reload-${index}`;
        await handler(
          "!room:example.org",
          createMatrixTextMessageEvent({ eventId, body: "hello" }),
        );
        const reactions = reactMatrixMessageMock.mock.calls.filter((call) => call[1] === eventId);
        expect(reactions.some((call) => call[2] === "👀")).toBe(
          accountScope === undefined && scope === "all",
        );
      }
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(3);
    },
  );

  it("resolves a reply's presentation before the room delivery reads it", async () => {
    const runGate = createDeferred<void>();
    const captured = createDeferred<DeliverFn>();

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "off",
      createReplyDispatcherWithTyping: (params) => {
        captured.resolve((params as { deliver: DeliverFn }).deliver);
        return {
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async () => {
        await runGate.promise;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const handlerDone = handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "deploy?" }),
    );
    const deliver = await captured.promise;
    try {
      await deliver(
        {
          presentation: {
            blocks: [
              { type: "text", text: "Deploy to production?" },
              {
                type: "buttons",
                buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
              },
            ],
          },
        },
        { kind: "final" },
      );
    } finally {
      runGate.resolve();
      await handlerDone;
    }

    const delivered = sendMessageMatrixMock.mock.calls[0];
    expect(delivered?.[1]).toContain("Deploy to production?");
    expect(delivered?.[2].extraContent?.["com.openclaw.presentation"]).toMatchObject({
      type: "message.presentation",
      version: 1,
    });
  });

  it.each(["controls", "answer"] as const)("edits a live preview for %s", async (kind) => {
    const context = {
      cfg: { channels: { matrix: {} } },
      client: {} as MatrixClient,
      roomId: "!room:example.org",
      accountId: "ops",
      streaming: "partial" as const,
      replyToMode: "off" as const,
      logVerboseMessage: vi.fn(),
    };
    const draftController = await createMatrixDraftController({
      ...context,
      messageId: "$msg1",
      previewToolProgressEnabled: false,
    });
    const draftStream = draftController.draftStream;
    if (!draftStream) {
      throw new Error("partial streaming must create a draft stream");
    }
    const finalizeLive = vi.spyOn(draftStream, "finalizeLive");
    const typingCallbacks = createTypingCallbacks({
      start: async () => {},
      onStartError: vi.fn(),
    });
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Approve", action: { type: "callback" as const, value: "approve" } }],
        },
      ],
    };
    try {
      const payload =
        kind === "controls"
          ? await prepareMatrixReplyPayload({ presentation })
          : { text: "answer" };
      if (typeof payload.text !== "string") {
        throw new Error("prepared reply must have visible text");
      }
      const previewText = kind === "controls" ? payload.text : "answer\n\nNO_REPLY";
      draftController.onPartialReply(previewText);
      await draftStream.flush();
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(draftStream.matchesPreparedText(previewText)).toBe(true);

      const { deliverReply } = createMatrixReplyDispatcher({
        ...context,
        draftStream,
        draftController,
        prefixOptions: { responsePrefixContextProvider: () => ({}) },
        humanDelay: undefined,
        typingCallbacks,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        mediaLocalRoots: [],
      });
      const result = await deliverReply(payload, { kind: "final" });

      expect(editMessageMatrixMock).toHaveBeenCalledExactlyOnceWith(
        context.roomId,
        "$draft1",
        payload.text,
        expect.objectContaining(
          kind === "controls"
            ? {
                extraContent: {
                  "com.openclaw.presentation": expect.objectContaining({
                    type: "message.presentation",
                    version: 1,
                    blocks: presentation.blocks,
                  }),
                },
              }
            : {},
        ),
      );
      expect(finalizeLive).not.toHaveBeenCalled();
      expect(sendMessageMatrixMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ messageIds: ["$draft1"], visibleReplySent: true });
    } finally {
      await draftStream.discardPending();
      draftController.cancelProgressDraft();
      typingCallbacks.onCleanup?.();
      finalizeLive.mockRestore();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pairingHarness(
  options: Parameters<typeof createMatrixHandlerTestHarness>[0],
  mentionRoom = false,
) {
  const harness = createMatrixHandlerTestHarness({
    dmPolicy: "pairing",
    isDirectMessage: true,
    getMemberDisplayName: async () => "sender",
    ...options,
  });
  const send = (eventId: string, sender = "@user:example.org") =>
    harness.handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId,
        sender,
        body: "hello",
        ...(mentionRoom ? { mentions: { room: true } } : {}),
      }),
    );
  return { ...harness, send };
}

describe("matrix monitor handler pairing", () => {
  it("does not send pairing reminders when the pending queue is full", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const f = pairingHarness(
      {
        readAllowFromStore: vi.fn(async () => [] as string[]),
        upsertPairingRequest: vi.fn(async () => ({ code: "", created: false })),
        buildPairingReply: () => "Pairing code: ",
      },
      true,
    );
    await f.send("$event1");
    await f.send("$event2");
    expect(f.readAllowFromStore).toHaveBeenCalledWith({
      channel: "matrix",
      env: process.env,
      accountId: "ops",
    });
    expect(f.upsertPairingRequest).toHaveBeenCalledWith({
      channel: "matrix",
      id: "@user:example.org",
      accountId: "ops",
      meta: { name: "sender" },
    });
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await f.send("$event3");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(f.runPrepared).not.toHaveBeenCalled();
  });

  it("bounds pairing cooldown senders when every pairing request is newly created", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T12:00:00Z"));
    let created = true;
    const f = pairingHarness({ upsertPairingRequest: async () => ({ code: "ABCDEFGH", created }) });
    const send = (sender: number, eventId: string) =>
      f.send(eventId, `@user-${sender}:example.org`);
    for (let sender = 0; sender <= 512; sender += 1) {
      await send(sender, `$created-${sender}`);
    }
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(513);
    created = false;
    await send(512, "$recent-reminder");
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(513);
    await send(0, "$evicted-reminder");
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(514);
    created = true;
    await send(512, "$new-request");
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(515);
    expect(f.runPrepared).not.toHaveBeenCalled();
  });
});
