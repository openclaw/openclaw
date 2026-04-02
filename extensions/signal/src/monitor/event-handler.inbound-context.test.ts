import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalEventHandlerDeps, SignalReactionMessage } from "./event-handler.types.js";

let expectInboundContextContract: typeof import("openclaw/plugin-sdk/testing").expectChannelInboundContextContract;
let createBaseSignalEventHandlerDeps: typeof import("./event-handler.test-harness.js").createBaseSignalEventHandlerDeps;
let createSignalReceiveEvent: typeof import("./event-handler.test-harness.js").createSignalReceiveEvent;
let capturedCtxs: MsgContext[] = [];

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock, capture } = vi.hoisted(
  () => {
    const captureState: { ctx: MsgContext | undefined } = { ctx: undefined };
    return {
      sendTypingMock: vi.fn(),
      sendReadReceiptMock: vi.fn(),
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: { onReplyStart?: () => void | Promise<void> };
        }) => {
          captureState.ctx = params.ctx;
          capturedCtxs.push(params.ctx);
          await Promise.resolve(params.replyOptions?.onReplyStart?.());
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      ),
      capture: captureState,
    };
  },
);

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

let createSignalEventHandler: typeof import("./event-handler.js").createSignalEventHandler;

async function loadSignalEventHandlerModules() {
  ({ expectChannelInboundContextContract: expectInboundContextContract } =
    await import("openclaw/plugin-sdk/testing"));
  ({ createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
    await import("./event-handler.test-harness.js"));
  ({ createSignalEventHandler } = await import("./event-handler.js"));
}

function createTestHandler(overrides: Partial<SignalEventHandlerDeps> = {}) {
  return createSignalEventHandler({
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {}, error: () => {} } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 0,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    injectLinkPreviews: true,
    preserveTextStyles: true,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (
      _reaction: SignalReactionMessage | null | undefined,
    ): _reaction is SignalReactionMessage => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides,
  });
}

function makeReceiveEvent(
  dataMessage: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: {
          message: "",
          attachments: [],
          ...dataMessage,
        },
        ...envelope,
      },
    }),
  };
}

describe("signal createSignalEventHandler inbound context", () => {
  beforeAll(async () => {
    vi.useRealTimers();
    await loadSignalEventHandlerModules();
  });

  beforeEach(() => {
    capture.ctx = undefined;
    capturedCtxs = [];
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    const contextWithBody = capture.ctx!;
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx!;
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith("+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.any(Object),
    );
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: [] } },
        },
        allowFrom: [],
        groupAllowFrom: [],
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "/status",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.CommandAuthorized).toBe(false);
  });

  it("forwards all fetched attachments via MediaPaths/MediaTypes", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.dat`,
          contentType: attachment.id === "a1" ? "image/jpeg" : undefined,
        }),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          attachments: [{ id: "a1", contentType: "image/jpeg" }, { id: "a2" }],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.MediaPath).toBe("/tmp/a1.dat");
    expect(capture.ctx?.MediaType).toBe("image/jpeg");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/jpeg", "application/octet-stream"]);
  });

  it("drops own UUID inbound messages when only accountUuid is configured", async () => {
    const ownUuid = "123e4567-e89b-12d3-a456-426614174000";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"], accountUuid: ownUuid } },
        },
        account: undefined,
        accountUuid: ownUuid,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: ownUuid,
        dataMessage: {
          message: "self message",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("drops sync envelopes when syncMessage is present but null", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        syncMessage: null,
        dataMessage: {
          message: "replayed sentTranscript envelope",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });
});

describe("signal enhanced inbound contract coverage", () => {
  beforeAll(async () => {
    vi.useRealTimers();
    await loadSignalEventHandlerModules();
  });

  beforeEach(() => {
    capture.ctx = undefined;
    capturedCtxs = [];
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("maps all attachments to plural media fields and preserves first-item aliases", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        return { path: "/tmp/signal-att-1.jpg", contentType: "image/jpeg" };
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          { id: "att-1", contentType: "image/jpeg" },
          { id: "att-2", contentType: "image/png" },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(capture.ctx?.MediaPath).toBe("/tmp/signal-att-1.jpg");
    expect(capture.ctx?.MediaType).toBe("image/jpeg");
    expect(capture.ctx?.MediaUrl).toBe("/tmp/signal-att-1.jpg");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/signal-att-1.jpg", "/tmp/signal-att-2.png"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/signal-att-1.jpg", "/tmp/signal-att-2.png"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/jpeg", "image/png"]);
  });

  it("keeps media type array aligned with media paths when content type is missing", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        return { path: "/tmp/signal-att-1.bin" };
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [{ id: "att-1" }, { id: "att-2", contentType: "image/png" }],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/signal-att-1.bin", "/tmp/signal-att-2.png"]);
    expect(capture.ctx?.MediaTypes).toEqual(["application/octet-stream", "image/png"]);
    expect(capture.ctx?.MediaType).toBe("application/octet-stream");
  });

  it("keeps successful attachments when one attachment fetch fails", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        throw new Error("network timeout");
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          { id: "att-1", contentType: "image/jpeg" },
          { id: "att-2", contentType: "image/png" },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/signal-att-2.png"]);
    expect(capture.ctx?.MediaPath).toBe("/tmp/signal-att-2.png");
    expect(capture.ctx?.MediaType).toBe("image/png");
  });

  it("maps quote metadata to reply context fields", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with quote",
        quote: {
          id: 9001,
          text: "original message",
          authorUuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.ReplyToId).toBe("9001");
    expect(capture.ctx?.ReplyToSender).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(capture.ctx?.ReplyToBody).toBe("original message");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("falls back quote reply metadata to timestamp and author number", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with quote",
        quote: {
          timestamp: 1700000000111,
          text: "fallback author message",
          authorNumber: "+15550002222",
          author: "fallback",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.ReplyToId).toBe("1700000000111");
    expect(capture.ctx?.ReplyToSender).toBe("+15550002222");
    expect(capture.ctx?.ReplyToBody).toBe("fallback author message");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("sets reply body to undefined when quoted text is missing", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with empty quote",
        quote: {
          id: 9002,
          text: "   ",
          authorUuid: "123e4567-e89b-12d3-a456-426614174001",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.ReplyToId).toBe("9002");
    expect(capture.ctx?.ReplyToSender).toBe("123e4567-e89b-12d3-a456-426614174001");
    expect(capture.ctx?.ReplyToBody).toBeUndefined();
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("clears quote metadata but preserves untrusted context when debounced entries are merged", async () => {
    const handler = createTestHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 50 } } } as any,
    });

    await handler(makeReceiveEvent({ message: "first message" }));
    await handler(
      makeReceiveEvent({
        message: "second message",
        quote: { id: 42, text: "quoted" },
        previews: [{ url: "https://example.com", title: "Example", description: "Desc" }],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(capturedCtxs).toHaveLength(1);
    expect(capture.ctx?.BodyForCommands).toBe("first message\nsecond message");
    expect(capture.ctx?.ReplyToId).toBeUndefined();
    expect(capture.ctx?.ReplyToBody).toBeUndefined();
    expect(capture.ctx?.ReplyToSender).toBeUndefined();
    expect(capture.ctx?.ReplyToIsQuote).toBeUndefined();
    // Untrusted context is merged from all entries (link preview from second message survives)
    expect(capture.ctx?.UntrustedContext).toBeDefined();
    expect(capture.ctx?.UntrustedContext).toContain(
      "Link preview: Example - Desc (https://example.com)",
    );
  });

  it("merges untrusted context from multiple debounced poll vote entries", async () => {
    const handler = createTestHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 50 } } } as any,
    });

    await handler(
      makeReceiveEvent({
        pollVote: {
          authorNumber: "+15551234567",
          targetSentTimestamp: 1234567890,
          optionIndexes: [0],
          voteCount: 1,
        },
      }),
    );
    await handler(
      makeReceiveEvent({
        pollVote: {
          authorNumber: "+15551234567",
          targetSentTimestamp: 1234567890,
          optionIndexes: [0, 2],
          voteCount: 1,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(capturedCtxs).toHaveLength(1);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll vote]\n[Poll vote]");
    // Both poll vote contexts should survive the merge
    expect(capture.ctx?.UntrustedContext).toBeDefined();
    expect(capture.ctx?.UntrustedContext).toContain("Poll vote on #1234567890: option(s) 0");
    expect(capture.ctx?.UntrustedContext).toContain("Poll vote on #1234567890: option(s) 0, 2");
  });

  it("handles sticker messages with sticker placeholder, downloaded media, and metadata", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "sticker-att-1") {
        return { path: "/tmp/signal-sticker-1.webp", contentType: "image/webp" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        sticker: {
          packId: "signal-pack-1",
          stickerId: 42,
          attachment: {
            id: "sticker-att-1",
            contentType: "image/webp",
          },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(capture.ctx?.BodyForCommands).toBe("<media:sticker>");
    expect(capture.ctx?.MediaPath).toBe("/tmp/signal-sticker-1.webp");
    expect(capture.ctx?.MediaType).toBe("image/webp");
    expect(capture.ctx?.MediaUrl).toBe("/tmp/signal-sticker-1.webp");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/signal-sticker-1.webp"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/signal-sticker-1.webp"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/webp"]);
    expect(capture.ctx?.UntrustedContext).toContain("Signal sticker packId: signal-pack-1");
    expect(capture.ctx?.UntrustedContext).toContain("Signal stickerId: 42");
  });

  it("passes attachment dimensions into media context fields", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "img-att-1") {
        return { path: "/tmp/signal-img-1.jpg", contentType: "image/jpeg" };
      }
      if (params.attachment?.id === "img-att-2") {
        return { path: "/tmp/signal-img-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "img-att-1",
            contentType: "image/jpeg",
            width: 4000,
            height: 3000,
          },
          {
            id: "img-att-2",
            contentType: "image/png",
            width: 1920,
            height: 1080,
          },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.MediaDimension).toEqual({ width: 4000, height: 3000 });
    expect(capture.ctx?.MediaDimensions).toEqual([
      { width: 4000, height: 3000 },
      { width: 1920, height: 1080 },
    ]);
  });

  it("threads attachment captions into media caption context fields", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "img-cap-1") {
        return { path: "/tmp/signal-cap-1.jpg", contentType: "image/jpeg" };
      }
      if (params.attachment?.id === "img-cap-2") {
        return { path: "/tmp/signal-cap-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "img-cap-1",
            contentType: "image/jpeg",
            caption: "sunset",
          },
          {
            id: "img-cap-2",
            contentType: "image/png",
            caption: "mountain",
          },
        ],
      }),
    );

    const ctx = capture.ctx as MsgContext & {
      MediaCaption?: string;
      MediaCaptions?: string[];
    };
    expect(ctx).toBeTruthy();
    expect(ctx.MediaCaption).toBe("sunset");
    expect(ctx.MediaCaptions).toEqual(["sunset", "mountain"]);
  });

  it("tracks edit target timestamp for edited messages", async () => {
    const handler = createTestHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000999,
          editMessage: {
            targetSentTimestamp: 1700000000111,
            dataMessage: {
              message: "edited text",
              attachments: [],
            },
          },
        },
      }),
    });

    const ctx = capture.ctx as MsgContext & {
      EditTargetTimestamp?: number;
    };
    expect(ctx).toBeTruthy();
    expect(ctx.EditTargetTimestamp).toBe(1700000000111);
    expect(ctx.BodyForCommands).toBe("edited text");
  });

  it("adds link preview metadata to untrusted context", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "check this",
        previews: [
          {
            url: "https://example.com/post",
            title: "Example Post",
            description: "A useful summary",
          },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.UntrustedContext).toContain(
      "Link preview: Example Post - A useful summary (https://example.com/post)",
    );
  });

  it("formats signal text styles into markdown in the message body", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForCommands).toBe("**hello** _world_");
  });

  it("skips link preview injection when injectLinkPreviews is false", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
    });

    await handler(
      makeReceiveEvent({
        message: "check this",
        previews: [
          {
            url: "https://example.com/post",
            title: "Example Post",
            description: "A useful summary",
          },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const untrusted = capture.ctx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).not.toContain("Link preview");
    expect(untrusted).not.toContain("https://example.com/post");
  });

  it("skips text style formatting when preserveTextStyles is false", async () => {
    const handler = createTestHandler({
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForCommands).toBe("hello world");
    expect(capture.ctx?.BodyForCommands).not.toContain("**");
    expect(capture.ctx?.BodyForCommands).not.toContain("_");
  });

  it("applies text styles correctly when message contains mentions", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "\uFFFC check this out",
        mentions: [
          {
            uuid: "550e8400-e29b-41d4-a716-446655440000",
            start: 0,
            length: 1,
          },
        ],
        textStyles: [
          { style: "BOLD", start: 2, length: 5 }, // "check" in original message
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForCommands).toContain("@550e8400-e29b-41d4-a716-446655440000");
    expect(capture.ctx?.BodyForCommands).toContain("**check**");
    expect(capture.ctx?.BodyForCommands).toBe(
      "@550e8400-e29b-41d4-a716-446655440000 **check** this out",
    );
  });

  it("keeps a style span aligned when it starts at a mention placeholder", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "\uFFFC check",
        mentions: [
          {
            uuid: "550e8400-e29b-41d4-a716-446655440000",
            start: 0,
            length: 1,
          },
        ],
        textStyles: [
          { style: "BOLD", start: 0, length: 7 }, // entire raw message
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForCommands).toBe("**@550e8400-e29b-41d4-a716-446655440000 check**");
  });

  it("adds shared contact metadata to untrusted context and uses contact placeholder", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        contacts: [
          {
            name: {
              display: "Jane Doe",
              given: "Jane",
              family: "Doe",
            },
            phone: [{ value: "+15551234567", type: "mobile" }],
            email: [{ value: "jane@example.com", type: "work" }],
            organization: "Acme Corp",
          },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.UntrustedContext).toContain(
      "Shared contact: Jane Doe (+15551234567, jane@example.com, Acme Corp)",
    );
    expect(capture.ctx?.BodyForCommands).toBe("<media:contact>");
  });

  it("includes both message text and contact context when contact has message", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "Here's John's info",
        contacts: [
          {
            name: {
              given: "John",
              family: "Smith",
            },
            phone: [{ value: "+15559876543" }],
            email: [{ value: "john@example.org" }],
          },
        ],
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForCommands).toBe("Here's John's info");
    expect(capture.ctx?.UntrustedContext).toContain(
      "Shared contact: John Smith (+15559876543, john@example.org)",
    );
  });

  it("renders poll creation with question and options", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollCreate: {
          question: "What's for lunch?",
          allowMultiple: false,
          options: ["Pizza", "Sushi", "Tacos"],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll] What's for lunch?");
    expect(capture.ctx?.UntrustedContext).toContain(
      'Poll: "What\'s for lunch?" — Options: Pizza, Sushi, Tacos',
    );
  });

  it("renders multi-select poll creation", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollCreate: {
          question: "Pick your favorites",
          allowMultiple: true,
          options: ["Coffee", "Tea", "Water"],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll] Pick your favorites");
    expect(capture.ctx?.UntrustedContext).toContain(
      'Poll: "Pick your favorites" — Options: Coffee, Tea, Water (multiple selections allowed)',
    );
  });

  it("renders poll vote with option indexes", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollVote: {
          authorNumber: "+15551234567",
          targetSentTimestamp: 1234567890,
          optionIndexes: [1, 3],
          voteCount: 2,
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll vote]");
    expect(capture.ctx?.UntrustedContext).toContain("Poll vote on #1234567890: option(s) 1, 3");
  });

  it("renders poll termination", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollTerminate: {
          targetSentTimestamp: 1234567890,
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll closed]");
    expect(capture.ctx?.UntrustedContext).toContain("Poll #1234567890 closed");
  });

  it("uses Untitled placeholder for null question with empty options", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollCreate: {
          question: null,
          allowMultiple: false,
          options: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll] Untitled");
    expect(capture.ctx?.UntrustedContext).toContain('Poll: "Untitled"');
  });

  it("does not include poll creator author fields in poll vote context", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        pollVote: {
          authorNumber: null,
          authorUuid: "abc-123-uuid",
          targetSentTimestamp: 1234567890,
          optionIndexes: [0, 2],
          voteCount: 2,
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("[Poll vote]");
    expect(capture.ctx?.UntrustedContext).toContain("Poll vote on #1234567890: option(s) 0, 2");
    expect(capture.ctx?.UntrustedContext).not.toContain("abc-123-uuid");
  });

  it("preserves message body when poll is present", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "Check out this poll",
        pollCreate: {
          question: "Lunch?",
          allowMultiple: false,
          options: ["Pizza", "Sushi"],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    expect(capture.ctx?.BodyForCommands).toBe("Check out this poll");
    expect(capture.ctx?.UntrustedContext).toContain('Poll: "Lunch?" — Options: Pizza, Sushi');
  });
});
