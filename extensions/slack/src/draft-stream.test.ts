import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
import { createSlackDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSlackDraftStream>[0];
type DraftSendFn = typeof import("./send.js").sendMessageSlack;
type DraftEditFn = typeof import("./actions.js").editSlackMessage;
type DraftRemoveFn = typeof import("./actions.js").deleteSlackMessage;

const transport = vi.hoisted(() => ({
  send: vi.fn<DraftSendFn>(),
  edit: vi.fn<DraftEditFn>(),
  editRendered: vi.fn<typeof import("./actions.js").editSlackRenderedMessage>(),
  remove: vi.fn<DraftRemoveFn>(),
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageSlack: transport.send,
}));
vi.mock("./actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions.js")>()),
  editSlackMessage: transport.edit,
  editSlackRenderedMessage: transport.editRendered,
  deleteSlackMessage: transport.remove,
}));

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
  params: Pick<DraftStreamParams, "accountId" | "maxChars" | "eventScope" | "identity"> & {
    threadTs?: string;
    send?: DraftSendFn;
    remove?: DraftRemoveFn;
  } = {},
) {
  const send = transport.send
    .mockReset()
    .mockImplementation(params.send ?? (async () => slackDraftSendResult("111.222")));
  const edit = transport.edit.mockReset().mockImplementation(async () => {});
  const editRendered = transport.editRendered.mockReset().mockImplementation(async () => {});
  const remove = transport.remove.mockReset().mockImplementation(params.remove ?? (async () => {}));
  const warn = vi.fn<NonNullable<DraftStreamParams["warn"]>>();
  const stream = createSlackDraftStream({
    target: "channel:C123",
    cfg: {},
    token: "xoxb-test",
    accountId: params.accountId,
    throttleMs: 250,
    maxChars: params.maxChars,
    eventScope: params.eventScope,
    identity: params.identity,
    resolveThreadTs: params.threadTs ? () => params.threadTs : undefined,
    warn,
  });
  return { stream, send, edit, editRendered, remove, warn };
}

function publish(
  stream: ReturnType<typeof createSlackDraftStream>,
  update: Parameters<typeof stream.update>[0],
) {
  stream.update(update);
  return stream.flush();
}

function humanMessage(
  messageTs: string,
  overrides: Partial<Parameters<typeof noteSlackDraftConversationMessage>[0]> = {},
) {
  noteSlackDraftConversationMessage({
    channelId: "C123",
    threadTs: "100.000",
    userId: "U_OWNER",
    messageTs,
    ...overrides,
  });
}

function rotatingSend() {
  return vi
    .fn<DraftSendFn>()
    .mockResolvedValueOnce(slackDraftSendResult("100.100"))
    .mockResolvedValueOnce(slackDraftSendResult("100.300"));
}

describe("createSlackDraftStream", () => {
  it("waits for a complete preamble when a human reply rotates the draft", async () => {
    const { stream, send, edit } = createDraftStreamHarness({ threadTs: "100.000" });
    await publish(stream, "_I’ll check the report._");

    // The partial was admitted while a preview existed. A human can retire
    // that preview before the throttled transport gets to publish the edit.
    humanMessage("112.000", { userId: "U_HUMAN" });
    await publish(stream, { text: "_the_", allowNewMessage: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();

    await publish(stream, { text: "_then I’ll check the key releases._", allowNewMessage: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(send).mock.calls.at(-1)?.[1]).toBe("_then I’ll check the key releases._");
  });

  it("uses the enterprise event client for draft writes", async () => {
    const client = {} as NonNullable<DraftStreamParams["eventScope"]>["client"];
    const eventScope = { teamId: "T_TEST", client };
    const identity = { username: "test-agent", iconEmoji: ":robot_face:" };
    const text = "a".repeat(4205);
    const { stream, send, edit, remove, warn } = createDraftStreamHarness({ eventScope, identity });

    await publish(stream, text);
    await publish(stream, "hello world");
    await stream.clear();

    expect(send.mock.calls).toMatchObject([
      ["channel:C123", text, { eventScope, identity, token: "xoxb-test" }],
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(edit.mock.calls).toContainEqual([
      "C123",
      "111.222",
      "hello world",
      expect.objectContaining({ client }),
    ]);
    expect(remove).toHaveBeenCalledWith("C123", "111.222", expect.objectContaining({ client }));
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    await publish(stream, "same");
    await publish(stream, "same");

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it.each(["turn", "human"])("keeps the throttle window after a %s rotation", async (rotation) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const accountId = `throttled-${rotation}-rotation`;
    const send = rotatingSend();
    const { stream, edit } = createDraftStreamHarness({ accountId, threadTs: "100.000", send });
    try {
      await publish(stream, "first preview");
      stream.update("queued old preview");
      await vi.advanceTimersByTimeAsync(100);

      if (rotation === "turn") {
        stream.forceNewMessage();
      } else {
        humanMessage("100.200", { accountId, userId: "U_HUMAN" });
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
    const send = rotatingSend();
    const remove = vi.fn<DraftRemoveFn>(async () => {});
    remove.mockRejectedValueOnce(new Error("cleanup failed"));
    const { stream } = createDraftStreamHarness({ send, remove });
    const removedMessageIds = () => vi.mocked(remove).mock.calls.map(([, messageId]) => messageId);

    for (const text of ["first", "second"]) {
      await publish(stream, text);
      stream.forceNewMessage();
    }
    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300"]);

    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300", "100.100"]);
  });

  it("drains previews detached during an in-flight removal", async () => {
    const accountId = "detach-during-drop";
    const firstRemove = createDeferred<void>();
    const send = rotatingSend();
    const remove = vi
      .fn<DraftRemoveFn>()
      .mockImplementationOnce(() => firstRemove.promise)
      .mockResolvedValueOnce(undefined);
    const { stream } = createDraftStreamHarness({ accountId, threadTs: "100.000", send, remove });

    await publish(stream, "_first card_");
    humanMessage("100.200", { accountId });

    const dropping = stream.dropDetachedMessages();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    await publish(stream, "_second card_");
    humanMessage("100.400", { accountId });

    firstRemove.resolve();
    await dropping;

    expect(remove.mock.calls).toEqual([
      ["C123", "100.100", { token: "xoxb-test", accountId }],
      ["C123", "100.300", { token: "xoxb-test", accountId }],
    ]);
  });

  it("keeps simultaneous Enterprise Grid conversations isolated by workspace", async () => {
    const accountId = "enterprise-grid";
    const eventScope = {
      teamId: "T_FIRST",
      client: {} as NonNullable<DraftStreamParams["eventScope"]>["client"],
    };
    const send = rotatingSend();
    const { stream, edit } = createDraftStreamHarness({
      accountId,
      eventScope,
      threadTs: "100.000",
      send,
    });

    await publish(stream, "_first workspace_");
    humanMessage("100.200", { accountId, teamId: "T_SECOND", userId: "U_OTHER_WORKSPACE" });
    await publish(stream, "_still in the first workspace_");

    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();

    humanMessage("100.200", { accountId, teamId: "T_FIRST" });
    await publish(stream, "_after the real interruption_");

    expect([send.mock.calls.length, stream.messageId()]).toEqual([2, "100.300"]);
  });

  it("ignores older, duplicate, unrelated, and bot-authored conversation events", async () => {
    const accountId = "irrelevant-events";
    const { stream, send, edit } = createDraftStreamHarness({ accountId, threadTs: "100.000" });

    await publish(stream, "_still working_");

    for (const event of [
      { messageTs: "111.111" },
      { messageTs: "111.222" },
      { threadTs: "200.000" },
      { channelId: "C_OTHER" },
      { userId: "U_BOT", botUserId: "U_BOT" },
      { userId: "U_OTHER_BOT", botId: "B_OTHER" },
    ]) {
      humanMessage("111.333", { accountId, ...event });
    }

    await publish(stream, "_latest update_");

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledOnce();
    expect(stream.messageId()).toBe("111.222");
  });

  it("does not finalize a preview invalidated while the stream was being sealed", async () => {
    const accountId = "interrupted-sealed-preview";
    const { stream, edit } = createDraftStreamHarness({ accountId, threadTs: "100.000" });
    const finalize = vi.fn(async () => {});

    await publish(stream, "_nearly finished_");
    await stream.seal();
    humanMessage("111.333", { accountId });

    await expect(stream.finalizeMessage("111.222", finalize)).resolves.toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    await publish(stream, "123456");
    await publish(stream, "ok");

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps mention-safe rendered text through the rendered edit owner", async () => {
    const { stream, send, edit, editRendered } = createDraftStreamHarness();
    const native = "<@U0456EFGH> <#C0456EFGH> <!here>";
    const escaped = "&lt;@U0456EFGH&gt; &lt;#C0456EFGH&gt; &lt;!here&gt;";

    await publish(stream, { text: `first ${native}`, escapeMentions: true });
    await publish(stream, { text: `second ${native}`, escapeMentions: true });

    const sent = vi.mocked(send).mock.calls[0]!;
    expect(sent[1]).toContain(escaped);
    expect(sent[1]).not.toContain(native);
    expect(sent[2]).toEqual(expect.objectContaining({ textIsSlackMrkdwn: true }));
    expect(edit).not.toHaveBeenCalled();
    expect(editRendered).toHaveBeenCalledOnce();
    const edited = vi.mocked(editRendered).mock.calls[0]!;
    expect(edited[2]).toContain(escaped);
    expect(edited[2]).not.toContain(native);
  });
});
