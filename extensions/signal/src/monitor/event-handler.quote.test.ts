import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildInboundUserContextPrefix } from "../../../../src/auto-reply/reply/inbound-meta.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

type CapturedSignalQuoteContext = Pick<
  MsgContext,
  "Body" | "BodyForAgent" | "ReplyToBody" | "ReplyToId" | "ReplyToIsQuote" | "ReplyToSender"
> & {
  Body?: string;
  BodyForAgent?: string;
  ReplyToBody?: string;
  ReplyToId?: string;
  ReplyToIsQuote?: boolean;
  ReplyToSender?: string;
};

let capturedCtx: CapturedSignalQuoteContext | undefined;

const { dispatchInboundMessageMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(),
}));

function getCapturedCtx() {
  return capturedCtx as CapturedSignalQuoteContext;
}

vi.mock("../../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

function createQuoteHandler(overrides: Partial<SignalEventHandlerDeps> = {}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      historyLimit: 0,
      ...overrides,
    }),
  );
}

describe("signal quote reply handling", () => {
  beforeEach(() => {
    capturedCtx = undefined;
    dispatchInboundMessageMock.mockReset();
    dispatchInboundMessageMock.mockImplementation(async (params: { ctx: unknown }) => {
      capturedCtx = params.ctx as CapturedSignalQuoteContext;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
  });

  it("surfaces quoted text in reply metadata while preserving the new message text", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "Thanks for the info!",
          quote: {
            id: 1700000000000,
            authorNumber: "+15550003333",
            text: "The meeting is at 3pm",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.BodyForAgent).toBe("Thanks for the info!");
    expect(ctx?.ReplyToId).toBe("1700000000000");
    expect(ctx?.ReplyToBody).toBe("The meeting is at 3pm");
    expect(ctx?.ReplyToSender).toBe("+15550003333");
    expect(ctx?.ReplyToIsQuote).toBe(true);
    expect(String(ctx?.Body ?? "")).toContain("Thanks for the info!");
    expect(String(ctx?.Body ?? "")).toContain("[Quoting +15550003333 id:1700000000000]");
  });

  it("uses the latest quote target when debouncing rapid quoted Signal replies", async () => {
    vi.useFakeTimers();
    try {
      const handler = createQuoteHandler({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 25 } } } as any,
      });

      await handler(
        createSignalReceiveEvent({
          sourceNumber: "+15550002222",
          sourceName: "Bob",
          timestamp: 1700000000001,
          dataMessage: {
            message: "First chunk",
            quote: {
              id: 1700000000000,
              authorNumber: "+15550003333",
              text: "First quoted message",
            },
          },
        }),
      );
      await handler(
        createSignalReceiveEvent({
          sourceNumber: "+15550002222",
          sourceName: "Bob",
          timestamp: 1700000000002,
          dataMessage: {
            message: "Second chunk",
            quote: {
              id: 1700000000009,
              authorNumber: "+15550004444",
              text: "Second quoted message",
            },
          },
        }),
      );

      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30);
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      });

      const ctx = getCapturedCtx();
      expect(ctx?.BodyForAgent).toBe("First chunk\\nSecond chunk");
      expect(ctx?.ReplyToId).toBe("1700000000009");
      expect(ctx?.ReplyToBody).toBe("Second quoted message");
      expect(ctx?.ReplyToSender).toBe("+15550004444");
      expect(String(ctx?.Body ?? "")).toContain("[Quoting +15550004444 id:1700000000009]");
      expect(String(ctx?.Body ?? "")).not.toContain("[Quoting +15550003333 id:1700000000000]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps quote-only replies and exposes the replied-message context block", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: {
            id: 1700000000000,
            authorNumber: "+15550002222",
            text: "Original message to quote",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx).toBeTruthy();
    expect(ctx?.BodyForAgent).toBe("");
    expect(ctx?.ReplyToBody).toBe("Original message to quote");
    const userContext = buildInboundUserContextPrefix(ctx as MsgContext);
    expect(userContext).toContain("Replied message (untrusted, for context):");
    expect(userContext).toContain('"body": "Original message to quote"');
    expect(userContext).toContain('"sender_label": "+15550002222"');
  });

  it("hydrates Signal mentions inside quoted text before surfacing reply context", async () => {
    const handler = createQuoteHandler();
    const placeholder = "\uFFFC";

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "Replying now",
          quote: {
            id: 1700000000000,
            text: `${placeholder} can you check this?`,
            mentions: [{ uuid: "123e4567", start: 0, length: placeholder.length }],
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToBody).toBe("@123e4567 can you check this?");
    expect(String(ctx?.Body ?? "")).toContain('"@123e4567 can you check this?"');
  });

  it("uses quoted attachment placeholders for media replies without text", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "Nice photo!",
          quote: {
            id: 1700000000000,
            authorUuid: "123e4567-e89b-12d3-a456-426614174000",
            text: null,
            attachments: [{ contentType: "image/jpeg" }],
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToBody).toBe("<media:image>");
    expect(ctx?.ReplyToSender).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
  });

  it("falls back to a generic quoted body when signal-cli sends an empty quoted text string", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "Replying to media",
          quote: {
            id: 1700000000000,
            text: "",
            attachments: [],
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToId).toBe("1700000000000");
    expect(ctx?.ReplyToBody).toBe("<quoted message>");
  });

  it("drops invalid quote ids from reply metadata but keeps valid quoted text", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "I saw this",
          quote: {
            id: "1700000000000abc",
            authorNumber: "+15550002222",
            text: "Original text",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToId).toBeUndefined();
    expect(ctx?.ReplyToBody).toBe("Original text");
    expect(String(ctx?.Body ?? "")).not.toContain("id:1700000000000abc");
  });

  it("does not synthesize quote-only context from invalid negative ids", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: {
            id: -1,
            text: null,
          },
        },
      }),
    );

    expect(capturedCtx).toBeUndefined();
  });

  it("passes inherited reply state through deliverReplies for the current Signal message", async () => {
    const deliverReplies = vi.fn().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcher: {
          sendToolResult: (payload: { text: string }) => boolean;
          sendFinalReply: (payload: { text: string }) => boolean;
          markComplete: () => void;
          waitForIdle: () => Promise<void>;
        };
      }) => {
        capturedCtx = params.ctx as CapturedSignalQuoteContext;
        params.dispatcher.sendToolResult({ text: "First reply" });
        params.dispatcher.sendFinalReply({ text: "Second reply" });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );
    const handler = createQuoteHandler({ deliverReplies });

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "Incoming message",
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies.mock.calls[0]?.[0].replies[0]?.replyToId).toBeUndefined();
    expect(deliverReplies.mock.calls[1]?.[0].replies[0]?.replyToId).toBeUndefined();
    expect(deliverReplies.mock.calls[0]?.[0].inheritedReplyToId).toBe("1700000000000");
    expect(deliverReplies.mock.calls[1]?.[0].inheritedReplyToId).toBe("1700000000000");
    expect(deliverReplies.mock.calls[0]?.[0].replyDeliveryState).toBe(
      deliverReplies.mock.calls[1]?.[0].replyDeliveryState,
    );
  });

  it("preserves explicit replyToId values on later deliveries in the same turn", async () => {
    const deliverReplies = vi.fn().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcher: {
          sendToolResult: (payload: { text: string; replyToId: string }) => boolean;
          sendFinalReply: (payload: { text: string; replyToId: string }) => boolean;
          markComplete: () => void;
          waitForIdle: () => Promise<void>;
        };
      }) => {
        capturedCtx = params.ctx as CapturedSignalQuoteContext;
        params.dispatcher.sendToolResult({ text: "First reply", replyToId: "1700000000001" });
        params.dispatcher.sendFinalReply({ text: "Second reply", replyToId: "1700000000002" });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );
    const handler = createQuoteHandler({ deliverReplies });

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "Incoming message",
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies.mock.calls[0]?.[0].replies[0]?.replyToId).toBe("1700000000001");
    expect(deliverReplies.mock.calls[1]?.[0].replies[0]?.replyToId).toBe("1700000000002");
  });

  it("resolves missing quote authors from previously seen group messages", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "The meeting is at 3pm",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    capturedCtx = undefined;

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550003333",
        sourceName: "Alice",
        timestamp: 1700000000002,
        dataMessage: {
          message: "Thanks for the info!",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          quote: {
            id: 1700000000001,
            text: "The meeting is at 3pm",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToSender).toBe("+15550002222");
    expect(String(ctx?.Body ?? "")).toContain("[Quoting +15550002222 id:1700000000001]");
  });

  it("does not poison the quote-author cache from attacker-controlled quote metadata", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "Forwarding this",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          quote: {
            id: 1700000000000,
            authorNumber: "+15550009999",
            text: "Mallory wrote this",
          },
        },
      }),
    );

    capturedCtx = undefined;

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550003333",
        sourceName: "Alice",
        timestamp: 1700000000002,
        dataMessage: {
          message: "Replying to Bob",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          quote: {
            id: 1700000000001,
            text: "Forwarding this",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToSender).toBe("+15550002222");
    expect(String(ctx?.Body ?? "")).toContain("[Quoting +15550002222 id:1700000000001]");
  });

  it("resolves cached uuid senders with a uuid: prefix", async () => {
    const handler = createQuoteHandler();
    const senderUuid = "123e4567-e89b-12d3-a456-426614174000";

    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: senderUuid,
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "The meeting is at 3pm",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    capturedCtx = undefined;

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550003333",
        sourceName: "Alice",
        timestamp: 1700000000002,
        dataMessage: {
          message: "Thanks for the info!",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          quote: {
            id: 1700000000001,
            text: "The meeting is at 3pm",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToSender).toBe(`uuid:${senderUuid}`);
    expect(String(ctx?.Body ?? "")).toContain(`[Quoting uuid:${senderUuid} id:1700000000001]`);
  });

  it("preserves uuid: prefix in quote author normalization", async () => {
    const handler = createQuoteHandler();

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "Thanks for the info!",
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          quote: {
            id: 1700000000000,
            authorUuid: "uuid:01234567-89ab-cdef-0123-456789abcdef",
            text: "The meeting is at 3pm",
          },
        },
      }),
    );

    const ctx = getCapturedCtx();
    expect(ctx?.ReplyToSender).toBe("uuid:01234567-89ab-cdef-0123-456789abcdef");
    expect(String(ctx?.Body ?? "")).toContain(
      "[Quoting uuid:01234567-89ab-cdef-0123-456789abcdef id:1700000000000]",
    );
  });
});
