// Slack tests cover draft stream plugin behavior.
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
import { createSlackDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSlackDraftStream>[0];
type DraftSendFn = NonNullable<DraftStreamParams["send"]>;
type DraftEditFn = NonNullable<DraftStreamParams["edit"]>;
type DraftRemoveFn = NonNullable<DraftStreamParams["remove"]>;
type DraftWarnFn = NonNullable<DraftStreamParams["warn"]>;
type MockCalls<TArgs extends readonly unknown[]> = { mock: { calls: TArgs[] } };

const TEST_CFG = {};

function mockCalls<TArgs extends readonly unknown[]>(fn: unknown): TArgs[] {
  return (fn as MockCalls<TArgs>).mock.calls;
}

function slackDraftSendResult(messageId: string, channelId = "C123") {
  return {
    channelId,
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "slack", messageId, channelId }],
      kind: "preview",
    }),
  };
}

function createDraftStreamHarness(
  params: {
    accountId?: string;
    maxChars?: number;
    threadTs?: string;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    eventScope?: DraftStreamParams["eventScope"];
    remove?: DraftRemoveFn;
    warn?: DraftWarnFn;
  } = {},
) {
  const send = params.send ?? vi.fn<DraftSendFn>(async () => slackDraftSendResult("111.222"));
  const edit = params.edit ?? vi.fn<DraftEditFn>(async () => {});
  const remove = params.remove ?? vi.fn<DraftRemoveFn>(async () => {});
  const warn = params.warn ?? vi.fn<DraftWarnFn>();
  const stream = createSlackDraftStream({
    target: "channel:C123",
    cfg: TEST_CFG,
    token: "xoxb-test",
    accountId: params.accountId,
    conversationChannelId: "C123",
    throttleMs: 250,
    maxChars: params.maxChars,
    eventScope: params.eventScope,
    resolveThreadTs: params.threadTs ? () => params.threadTs : undefined,
    send,
    edit,
    remove,
    warn,
  });
  return { stream, send, edit, remove, warn };
}

describe("createSlackDraftStream", () => {
  it("waits for a complete preamble when a human reply rotates the draft", async () => {
    const { stream, send, edit } = createDraftStreamHarness({ threadTs: "100.000" });
    stream.update("_I’ll check the report._");
    await stream.flush();

    // The partial was admitted while a preview existed. A human can retire
    // that preview before the throttled transport gets to publish the edit.
    noteSlackDraftConversationMessage({
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "112.000",
      userId: "U_HUMAN",
    });
    stream.update({ text: "_the_", allowNewMessage: false });
    await stream.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();

    stream.update({ text: "_then I’ll check the key releases._", allowNewMessage: true });
    await stream.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(mockCalls<Parameters<DraftSendFn>>(send).at(-1)?.[1]).toBe(
      "_then I’ll check the key releases._",
    );
  });

  it("uses the enterprise event client for draft writes", async () => {
    const client = {} as NonNullable<DraftStreamParams["eventScope"]>["client"];
    const eventScope = {
      teamId: "T_TEST",
      client,
    };
    const { stream, send, edit, remove } = createDraftStreamHarness({ eventScope });

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();
    await stream.clear();

    expect(send).toHaveBeenCalledWith(
      "channel:C123",
      "hello",
      expect.objectContaining({ eventScope }),
    );
    expect(edit).toHaveBeenCalledWith(
      "C123",
      "111.222",
      "hello world",
      expect.objectContaining({ client }),
    );
    expect(remove).toHaveBeenCalledWith("C123", "111.222", expect.objectContaining({ client }));
  });

  it("forwards identity to the initial send call", async () => {
    const identity = { username: "test-agent", iconEmoji: ":robot_face:" };
    const send = vi.fn<DraftSendFn>(async () => slackDraftSendResult("111.222"));
    const stream = createSlackDraftStream({
      target: "channel:C123",
      cfg: TEST_CFG,
      token: "xoxb-test",
      throttleMs: 250,
      identity,
      send,
      edit: vi.fn<DraftEditFn>(async () => {}),
      remove: vi.fn<DraftRemoveFn>(async () => {}),
    });

    stream.update("hello");
    await stream.flush();

    const sendCall = mockCalls<Parameters<DraftSendFn>>(send)[0];
    expect(sendCall?.[0]).toBe("channel:C123");
    expect(sendCall?.[1]).toBe("hello");
    expect((sendCall?.[2] as { identity?: unknown } | undefined)?.identity).toEqual(identity);
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it.each(["turn", "human"])("keeps the throttle window after a %s rotation", async (rotation) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const accountId = `throttled-${rotation}-rotation`;
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream, edit } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
    });
    try {
      stream.update("first preview");
      await stream.flush();
      stream.update("queued old preview");
      await vi.advanceTimersByTimeAsync(100);

      if (rotation === "turn") {
        stream.forceNewMessage();
      } else {
        noteSlackDraftConversationMessage({
          accountId,
          channelId: "C123",
          threadTs: "100.000",
          messageTs: "100.200",
          userId: "U_HUMAN",
        });
      }
      stream.update("replacement preview");
      expect(send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(149);
      expect(send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(
        "channel:C123",
        "replacement preview",
        expect.any(Object),
      );
      expect(edit).not.toHaveBeenCalled();
    } finally {
      await stream.clear();
      vi.useRealTimers();
    }
  });

  it("drains past a failed preview and retries only the retained failure", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const remove = vi.fn<DraftRemoveFn>(async () => {});
    remove.mockRejectedValueOnce(new Error("cleanup failed"));
    const { stream } = createDraftStreamHarness({ send, remove });
    const removedMessageIds = () =>
      mockCalls<Parameters<DraftRemoveFn>>(remove).map(([, messageId]) => messageId);

    for (const text of ["first", "second"]) {
      stream.update(text);
      await stream.flush();
      stream.forceNewMessage();
    }
    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300"]);

    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300", "100.100"]);
  });

  it("drains previews detached during an in-flight removal", async () => {
    const accountId = "detach-during-drop";
    let finishFirstRemove: (() => void) | undefined;
    const firstRemove = new Promise<void>((resolve) => {
      finishFirstRemove = resolve;
    });
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const remove = vi
      .fn<DraftRemoveFn>()
      .mockImplementationOnce(async () => await firstRemove)
      .mockResolvedValueOnce(undefined);
    const { stream } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
      remove,
    });

    stream.update("_first card_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });

    const dropping = stream.dropDetachedMessages();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledOnce();
    });

    stream.update("_second card_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.400",
      userId: "U_OWNER",
    });

    finishFirstRemove?.();
    await dropping;

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, "C123", "100.100", {
      token: "xoxb-test",
      accountId,
    });
    expect(remove).toHaveBeenNthCalledWith(2, "C123", "100.300", {
      token: "xoxb-test",
      accountId,
    });
  });

  it("keeps simultaneous Enterprise Grid conversations isolated by workspace", async () => {
    const accountId = "enterprise-grid";
    const eventScope = {
      teamId: "T_FIRST",
      client: {} as NonNullable<DraftStreamParams["eventScope"]>["client"],
    };
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream, edit } = createDraftStreamHarness({
      accountId,
      eventScope,
      threadTs: "100.000",
      send,
    });

    stream.update("_first workspace_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      teamId: "T_SECOND",
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OTHER_WORKSPACE",
    });
    stream.update("_still in the first workspace_");
    await stream.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();

    noteSlackDraftConversationMessage({
      accountId,
      teamId: "T_FIRST",
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });
    stream.update("_after the real interruption_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(stream.messageId()).toBe("100.300");
  });

  it("ignores older, duplicate, unrelated, and bot-authored conversation events", async () => {
    const accountId = "irrelevant-events";
    const { stream, send, edit } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
    });

    stream.update("_still working_");
    await stream.flush();

    for (const event of [
      { channelId: "C123", threadTs: "100.000", messageTs: "111.111", userId: "U_OWNER" },
      { channelId: "C123", threadTs: "100.000", messageTs: "111.222", userId: "U_OWNER" },
      { channelId: "C123", threadTs: "200.000", messageTs: "111.333", userId: "U_OWNER" },
      { channelId: "C_OTHER", threadTs: "100.000", messageTs: "111.333", userId: "U_OWNER" },
      {
        channelId: "C123",
        threadTs: "100.000",
        messageTs: "111.333",
        userId: "U_BOT",
        botUserId: "U_BOT",
      },
      {
        channelId: "C123",
        threadTs: "100.000",
        messageTs: "111.333",
        userId: "U_OTHER_BOT",
        botId: "B_OTHER",
      },
    ]) {
      noteSlackDraftConversationMessage({ accountId, ...event });
    }

    stream.update("_latest update_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledOnce();
    expect(stream.messageId()).toBe("111.222");
  });

  it("does not finalize a preview invalidated while the stream was being sealed", async () => {
    const accountId = "interrupted-sealed-preview";
    const { stream, edit } = createDraftStreamHarness({ accountId, threadTs: "100.000" });
    const finalize = vi.fn(async () => {});

    stream.update("_nearly finished_");
    await stream.flush();
    await stream.seal();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "111.333",
      userId: "U_OWNER",
    });

    await expect(stream.finalizeMessage("111.222", finalize)).resolves.toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows a 4205-character preview with the default max chars", async () => {
    const { stream, send, warn } = createDraftStreamHarness();
    const text = "a".repeat(4205);

    stream.update(text);
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    const sendCall = mockCalls<Parameters<DraftSendFn>>(send)[0];
    expect(sendCall?.[0]).toBe("channel:C123");
    expect(sendCall?.[1]).toBe(text);
    expect((sendCall?.[2] as { token?: string } | undefined)?.token).toBe("xoxb-test");
    expect(warn).not.toHaveBeenCalled();
  });
});
