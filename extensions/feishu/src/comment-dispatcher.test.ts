// Feishu tests cover comment dispatcher plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createReplyPrefixContextMock = vi.hoisted(() => vi.fn());
const createCommentTypingReactionLifecycleMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-dispatcher-runtime-api.js", () => ({
  createReplyPrefixContext: createReplyPrefixContextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: createCommentTypingReactionLifecycleMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: getFeishuRuntimeMock,
}));
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

describe("createFeishuCommentReplyDispatcher", () => {
  type CommentDispatcherOptions = {
    deliver: (
      payload: { text?: string; mediaUrl?: string },
      phase: { kind: string; assistantMessageIndex?: number; deliveryId?: number },
    ) => Promise<unknown>;
    onCleanup?: () => Promise<void> | void;
    onReplyStart?: () => Promise<void> | void;
  };
  const wrappedOptions = new WeakMap<object, CommentDispatcherOptions>();
  let latestCreated: ReturnType<typeof createFeishuCommentReplyDispatcher> | undefined;

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./comment-dispatcher-runtime-api.js");
    vi.doUnmock("./comment-reaction.js");
    vi.doUnmock("./drive.js");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  function createTestCommentReplyDispatcher() {
    const created = createFeishuCommentReplyDispatcher({
      cfg: {} as never,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      accountId: "main",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
    });
    latestCreated = created;
    return created;
  }

  function replyDispatcherOptions(created: ReturnType<typeof createFeishuCommentReplyDispatcher>) {
    const existing = wrappedOptions.get(created);
    if (existing) {
      return existing;
    }
    const source = {
      ...created.dispatcherOptions,
      deliver: created.delivery.deliver,
    } as CommentDispatcherOptions;
    const deliveryIds = new WeakMap<object, number>();
    let nextDeliveryId = 0;
    const wrapped: CommentDispatcherOptions = {
      ...source,
      deliver: (payload, phase) => {
        let deliveryId = phase.deliveryId ?? deliveryIds.get(payload);
        if (deliveryId === undefined) {
          deliveryId = nextDeliveryId;
          nextDeliveryId += 1;
          deliveryIds.set(payload, deliveryId);
        }
        return source.deliver(payload, { ...phase, deliveryId });
      },
    };
    wrappedOptions.set(created, wrapped);
    return wrapped;
  }

  function latestReplyDispatcherOptions() {
    if (!latestCreated) {
      throw new Error("expected comment reply dispatcher");
    }
    return replyDispatcherOptions(latestCreated);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    latestCreated = undefined;
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
    });
    createFeishuClientMock.mockReturnValue({});
    createReplyPrefixContextMock.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: undefined,
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          chunkTextWithMode: vi.fn((text: string) => [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup,
    });

    const created = createTestCommentReplyDispatcher();
    const options = replyDispatcherOptions(created);
    const deliverPromise = Promise.resolve(
      options.deliver({ text: "hello world" }, { kind: "final" }),
    );
    const status = await raceWithNextMacrotask(deliverPromise.then(() => "done"));

    expect(status).toBe("done");
    const client = createFeishuClientMock.mock.results[0]?.value;
    if (!client) {
      throw new Error("Expected Feishu client");
    }
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(client, {
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: "hello world",
      is_whole_comment: false,
    });
    expect(cleanup).not.toHaveBeenCalled();

    void options.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await deliverPromise;
  });

  it("starts the typing reaction from dispatcher onReplyStart", async () => {
    const start = vi.fn(async () => {});
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start,
      cleanup: vi.fn(async () => {}),
    });

    const created = createTestCommentReplyDispatcher();
    const options = replyDispatcherOptions(created);
    await options.onReplyStart?.();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("returns all provider comment ids for chunked final text", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.chunkTextWithMode.mockReturnValue(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_1" })
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_2" });
    createTestCommentReplyDispatcher();

    await expect(
      latestReplyDispatcherOptions().deliver({ text: "first second" }, { kind: "final" }),
    ).resolves.toMatchObject({
      visibleReplySent: true,
      messageId: "reply_1",
      content: "first second",
      receipt: { platformMessageIds: ["reply_1", "reply_2"] },
    });
  });

  it("reports a later chunk failure with the already-visible comment id", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.chunkTextWithMode.mockReturnValue(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_1" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    createTestCommentReplyDispatcher();
    const payload = { text: "first second" };

    await expect(
      latestReplyDispatcherOptions().deliver(payload, { kind: "final" }),
    ).rejects.toMatchObject({
      name: "PartialReplyDeliveryError",
      deliveryResult: {
        visibleReplySent: true,
        messageId: "reply_1",
        content: "first",
      },
    });

    deliverCommentThreadTextMock.mockResolvedValueOnce({
      delivery_mode: "reply_comment",
      reply_id: "reply_2",
    });
    await expect(
      latestReplyDispatcherOptions().deliver(payload, { kind: "final" }),
    ).resolves.toMatchObject({
      visibleReplySent: true,
      messageId: "reply_1",
      receipt: { platformMessageIds: ["reply_1", "reply_2"] },
    });
    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(3);
    expect(deliverCommentThreadTextMock.mock.calls[2]?.[1]?.content).toBe("second");
    expect(runtime.channel.text.chunkTextWithMode).toHaveBeenCalledTimes(1);
  });

  it("isolates retry progress for distinct unindexed deliveries with identical text", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.chunkTextWithMode.mockReturnValue(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_a1" })
      .mockRejectedValueOnce(new Error("reply A second chunk failed"))
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_b1" })
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_b2" })
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_a2" });
    createTestCommentReplyDispatcher();
    const options = latestReplyDispatcherOptions();
    const payload = { text: "same text" };

    await expect(options.deliver(payload, { kind: "final", deliveryId: 10 })).rejects.toMatchObject(
      { deliveryResult: { messageId: "reply_a1" } },
    );
    await expect(
      options.deliver(payload, { kind: "final", deliveryId: 11 }),
    ).resolves.toMatchObject({
      messageId: "reply_b1",
      receipt: { platformMessageIds: ["reply_b1", "reply_b2"] },
    });
    await expect(
      options.deliver(payload, { kind: "final", deliveryId: 10 }),
    ).resolves.toMatchObject({
      messageId: "reply_a1",
      receipt: { platformMessageIds: ["reply_a1", "reply_a2"] },
    });
    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(5);
  });

  it("marks unsupported comment media-only delivery as non-visible", async () => {
    createTestCommentReplyDispatcher();

    await expect(
      latestReplyDispatcherOptions().deliver(
        { mediaUrl: "https://example.com/image.png" },
        { kind: "final" },
      ),
    ).resolves.toEqual({ visibleReplySent: false });
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });
});
