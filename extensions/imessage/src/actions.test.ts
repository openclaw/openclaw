import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { imessageActionsRuntime } from "./actions.runtime.js";

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
  probeIMessagePrivateApi: vi.fn(),
}));
const runtimeMock = vi.hoisted(() => ({
  resolveIMessageMessageId: vi.fn((id: string) => id),
  authorizeMessageReference: vi.fn(),
  resolveChatGuidForTarget: vi.fn(),
  sendReaction: vi.fn<typeof imessageActionsRuntime.sendReaction>(),
  sendRichMessage: vi.fn(),
  editMessage: vi.fn(),
  unsendMessage: vi.fn(),
  sendAttachment: vi.fn(),
  renameGroup: vi.fn(),
  setGroupIcon: vi.fn(),
  leaveGroup: vi.fn(),
  sendPoll: vi.fn(),
  sendPollVote: vi.fn(),
}));
const rememberIMessageReplyCacheMock = vi.hoisted(() => vi.fn());
const remoteHostMock = vi.hoisted(() => ({ resolve: vi.fn(), getCached: vi.fn() }));
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  )),
  createSubsystemLogger: () => loggerMock,
}));
vi.mock("./probe.js", () => probeMock);
vi.mock("./private-api-status.js", async () => ({
  ...(await vi.importActual<typeof import("./private-api-status.js")>("./private-api-status.js")),
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
}));
vi.mock("./actions.runtime.js", () => ({ imessageActionsRuntime: runtimeMock }));
vi.mock("./remote-host.js", () => ({
  resolveIMessageRemoteHost: remoteHostMock.resolve,
  getCachedIMessageRemoteHost: remoteHostMock.getCached,
}));
vi.mock("./monitor-reply-cache.js", async () => ({
  ...(await vi.importActual<typeof import("./monitor-reply-cache.js")>("./monitor-reply-cache.js")),
  rememberIMessageReplyCache: rememberIMessageReplyCacheMock,
}));
const { imessageMessageActions } = await import("./actions.js");

const chatGuid = "iMessage;+;chat0000";
const message = { chatGuid, messageId: "message-guid" };
const poll = { chatGuid, pollQuestion: "Lunch?", pollOption: ["Pizza", "Sushi"] };
const options = {
  cliPath: "imsg",
  dbPath: "/tmp/messages.db",
  remoteHost: undefined,
  timeoutMs: undefined,
};
const voteStatus = {
  available: true,
  v2Ready: true,
  selectors: { pollVoteMessage: true },
  rpcMethods: ["send", "poll.send", "poll.vote"],
};

function cfg(actions?: Record<string, boolean | undefined>): OpenClawConfig {
  return { channels: { imessage: { cliPath: "imsg", dbPath: "/tmp/messages.db", actions } } };
}
function bridge(selectors: Record<string, boolean> = {}) {
  probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
    available: true,
    v2Ready: true,
    selectors,
  });
}
function attachmentBridge(supported = true) {
  probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
    available: true,
    v2Ready: true,
    selectors: {},
    cliCapabilities: { sendRichSupportsAttachment: supported },
  });
}
function run(
  action: ChannelMessageActionContext["action"],
  params: Record<string, unknown>,
  context: Partial<Omit<ChannelMessageActionContext, "action" | "params">> = {},
) {
  return imessageMessageActions.handleAction!({
    channel: "imessage",
    action,
    params,
    cfg: cfg(),
    ...context,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  runtimeMock.resolveIMessageMessageId.mockImplementation((id: string) => id);
  remoteHostMock.resolve.mockResolvedValue(undefined);
  remoteHostMock.getCached.mockReturnValue(undefined);
  bridge();
});

describe("imessage message actions", () => {
  it("advertises private actions before capabilities are known", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);
    expect(
      imessageMessageActions.describeMessageTool({
        cfg: cfg(),
        currentChannelId: "chat_guid:" + chatGuid,
      })?.actions,
    ).toStrictEqual([
      "react",
      "edit",
      "reply",
      "sendWithEffect",
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
      "poll",
      "poll-vote",
      "upload-file",
    ]);
  });

  it("respects configured gates and known selectors during discovery", () => {
    bridge({ editMessage: true, retractMessagePart: true });
    const actions = imessageMessageActions.describeMessageTool({
      cfg: cfg({ reactions: false, reply: false }),
      currentChannelId: "chat_guid:" + chatGuid,
    })?.actions;
    expect(actions).not.toContain("react");
    expect(actions).not.toContain("reply");
    expect(actions).not.toContain("poll");
    expect(actions).toContain("edit");
    expect(actions).toContain("unsend");
  });

  it("requires a trusted requester for iMessage group management", () => {
    for (const action of [
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
    ] as const) {
      expect(
        imessageMessageActions.requiresTrustedRequesterSender?.({
          action,
          toolContext: { currentChannelProvider: "imessage" },
        }),
      ).toBe(true);
    }
    expect(
      imessageMessageActions.requiresTrustedRequesterSender?.({
        action: "renameGroup",
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).toBe(false);
    expect(
      imessageMessageActions.requiresTrustedRequesterSender?.({
        action: "react",
        toolContext: { currentChannelProvider: "imessage" },
      }),
    ).toBe(false);
  });

  it("rejects group management before native mutation without owner or admin authority", async () => {
    await expect(
      run(
        "renameGroup",
        { chatGuid, name: "Unauthorized rename" },
        {
          senderIsOwner: false,
          gatewayClientScopes: ["operator.write"],
        },
      ),
    ).rejects.toThrow("iMessage group management requires an owner or operator.admin requester.");
    expect(runtimeMock.renameGroup).not.toHaveBeenCalled();
  });

  it("allows owner and operator.admin group management", async () => {
    await run("renameGroup", { chatGuid, name: "Renamed group" }, { senderIsOwner: true });
    await run(
      "leaveGroup",
      { chatGuid },
      { senderIsOwner: false, gatewayClientScopes: ["operator.admin"] },
    );
    expect(runtimeMock.renameGroup).toHaveBeenCalledWith({
      chatGuid,
      displayName: "Renamed group",
      options,
    });
    expect(runtimeMock.leaveGroup).toHaveBeenCalledWith({ chatGuid, options });
  });

  it("refreshes stale capabilities and sends a normalized current-conversation poll", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: ["send"],
    });
    probeMock.probeIMessagePrivateApi.mockResolvedValue({
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true },
      rpcMethods: ["send", "poll.send"],
    });
    runtimeMock.sendPoll.mockResolvedValue({ messageId: "poll-guid" });
    const result = await run(
      "poll",
      { pollQuestion: "  Lunch?  ", pollOption: [" Pizza ", "Sushi", ""] },
      {
        toolContext: { currentChannelId: "chat_guid:" + chatGuid },
      },
    );
    expect(probeMock.probeIMessagePrivateApi).toHaveBeenCalledWith("imsg", 10_000, {
      forceRefresh: true,
    });
    expect(runtimeMock.sendPoll.mock.calls).toStrictEqual([
      [
        {
          chatGuid,
          question: "Lunch?",
          choices: ["Pizza", "Sushi"],
          options,
        },
      ],
    ]);
    expect(result).toMatchObject({ details: { ok: true, messageId: "poll-guid" } });
  });

  it.each(["target", "chatGuid"])("rejects a redacted %s before sending", async (alias) => {
    bridge({ pollPayloadMessage: true });
    await expect(
      run(
        "poll",
        {
          [alias]: "***",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        { toolContext: { currentChannelId: "chat_guid:" + chatGuid } },
      ),
    ).rejects.toThrow("Omit the target to use the current conversation");
    expect(runtimeMock.sendPoll).not.toHaveBeenCalled();
  });

  it("rejects a poll when refreshing still leaves its payload selector missing", async () => {
    const stale = {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: ["send", "poll.send"],
    };
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(stale);
    probeMock.probeIMessagePrivateApi.mockResolvedValue(stale);
    await expect(run("poll", poll)).rejects.toThrow(/pollPayloadMessage selector.*imsg launch/);
    expect(probeMock.probeIMessagePrivateApi).toHaveBeenCalledWith("imsg", 10_000, {
      forceRefresh: true,
    });
    expect(runtimeMock.sendPoll).not.toHaveBeenCalled();
  });

  it("resolves and authorizes the current inbound poll before voting by index", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(voteStatus);
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("poll-full-guid");
    runtimeMock.sendPollVote.mockResolvedValue({ messageId: "vote-guid", optionText: "Blue" });
    const result = await run(
      "poll-vote",
      { chatGuid, pollOptionIndex: 2 },
      {
        toolContext: { currentMessageId: 3 },
        conversationReadOrigin: "delegated",
      },
    );
    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenCalledWith(
      "3",
      expect.objectContaining({ requireKnownShortId: true }),
    );
    expect(runtimeMock.authorizeMessageReference).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        messageId: "poll-full-guid",
        conversationReadOrigin: "delegated",
      }),
    );
    expect(runtimeMock.sendPollVote.mock.calls).toStrictEqual([
      [
        {
          chatGuid,
          pollGuid: "poll-full-guid",
          optionIndex: 2,
          optionId: undefined,
          optionText: undefined,
          options,
        },
      ],
    ]);
    expect(result).toMatchObject({
      details: { ok: true, messageId: "vote-guid", pollVotedOption: "Blue" },
    });
  });

  it.each([
    [{ pollOptionIndex: 2 }, "requires the poll message id"],
    [{ pollId: "3", pollOptionIndex: 2, pollOptionText: "Blue" }, "exactly one of"],
    [{ pollId: "3" }, "requires pollOptionIndex"],
  ] as const)("rejects invalid poll selection %j", async (params, error) => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(voteStatus);
    await expect(run("poll-vote", { chatGuid, ...params })).rejects.toThrow(error);
    expect(runtimeMock.sendPollVote).not.toHaveBeenCalled();
  });

  it.each([
    [
      { ...voteStatus, rpcMethods: ["send", "poll.send", "messages.poll.send"] },
      /poll.vote capability/,
    ],
    [
      { ...voteStatus, selectors: { pollPayloadMessage: true } },
      /pollVoteMessage selector.*imsg launch/,
    ],
  ] as const)("rejects missing poll-vote capability %j after refresh", async (stale, error) => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(stale);
    probeMock.probeIMessagePrivateApi.mockResolvedValue(stale);
    await expect(run("poll-vote", { chatGuid, pollId: "3", pollOptionIndex: 2 })).rejects.toThrow(
      error,
    );
    expect(probeMock.probeIMessagePrivateApi).toHaveBeenCalledWith("imsg", 10_000, {
      forceRefresh: true,
    });
    expect(runtimeMock.sendPollVote).not.toHaveBeenCalled();
  });

  it("dispatches a poll vote by plugin-owned text selector", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(voteStatus);
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("poll-full-guid");
    runtimeMock.sendPollVote.mockResolvedValue({ messageId: "vote-guid" });
    await run("poll-vote", { chatGuid, pollId: "3", pollOptionText: "Blue" });
    expect(runtimeMock.sendPollVote).toHaveBeenCalledWith(
      expect.objectContaining({
        optionText: "Blue",
        optionId: undefined,
        optionIndex: undefined,
      }),
    );
  });

  it("authorizes edits and uses the detected remote transport", async () => {
    const text = "spaces ; $(touch /tmp/nope) `whoami` & |";
    bridge({ editMessage: true });
    remoteHostMock.resolve.mockResolvedValue("bot@messages-mac");
    await run(
      "edit",
      { ...message, text },
      {
        cfg: {
          channels: {
            imessage: { cliPath: "/gateway/imsg-ssh", dbPath: "~/Library/Messages/chat.db" },
          },
        },
      },
    );
    expect(remoteHostMock.resolve).toHaveBeenCalledWith({
      cliPath: "/gateway/imsg-ssh",
      remoteHost: undefined,
    });
    expect(runtimeMock.resolveIMessageMessageId.mock.calls).toEqual([
      ["message-guid", expect.objectContaining({ requireFromMe: true })],
      ["message-guid", expect.not.objectContaining({ requireFromMe: expect.anything() })],
    ]);
    expect(runtimeMock.authorizeMessageReference).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-guid" }),
    );
    expect(runtimeMock.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text,
        options: expect.objectContaining({
          cliPath: "/gateway/imsg-ssh",
          dbPath: "~/Library/Messages/chat.db",
          remoteHost: "bot@messages-mac",
        }),
      }),
    );
  });

  it("rejects ambiguous SSH wrappers before editing", async () => {
    bridge({ editMessage: true });
    remoteHostMock.resolve.mockRejectedValueOnce(
      new Error(
        "iMessage SSH cliPath wrapper is not the simple transparent form; configure channels.imessage.remoteHost explicitly.",
      ),
    );
    await expect(
      run(
        "edit",
        { ...message, text: "updated text" },
        { cfg: { channels: { imessage: { cliPath: "/gateway/imsg-proxy-wrapper" } } } },
      ),
    ).rejects.toThrow("configure channels.imessage.remoteHost explicitly");
    expect(runtimeMock.editMessage).not.toHaveBeenCalled();
  });

  it("warns and rejects when probing finds the private bridge unavailable", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);
    probeMock.probeIMessagePrivateApi.mockResolvedValue({
      available: false,
      v2Ready: false,
      selectors: {},
    });
    await expect(run("react", { ...message, emoji: "👍" })).rejects.toThrow(
      /imsg private API bridge/,
    );
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toMatch(
      /iMessage react blocked: private API bridge unavailable/,
    );
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toMatch(/imsg launch/);
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("rejects configured-off actions at execution time", async () => {
    await expect(
      run("react", { ...message, emoji: "👍" }, { cfg: cfg({ reactions: false }) }),
    ).rejects.toThrow(/disabled in config/i);
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("rejects an unbound alias before provider reads", async () => {
    runtimeMock.authorizeMessageReference.mockImplementationOnce(() => {
      throw new Error("iMessage message reference belongs to a different conversation.");
    });
    await expect(
      run("react", { chatIdentifier: "foreign-chat", messageId: "foreign-guid", emoji: "👍" }),
    ).rejects.toThrow("different conversation");
    expect(runtimeMock.resolveChatGuidForTarget).not.toHaveBeenCalled();
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("authorizes a provider-resolved GUID independently of its input alias", async () => {
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;foreign");
    runtimeMock.authorizeMessageReference.mockImplementation(({ chatContext }) => {
      if (chatContext.chatGuid) {
        throw new Error("iMessage message reference belongs to a different conversation.");
      }
    });
    await expect(
      run("react", { chatIdentifier: "trusted-alias", messageId: "message-guid", emoji: "👍" }),
    ).rejects.toThrow("different conversation");
    expect(runtimeMock.authorizeMessageReference.mock.calls).toEqual([
      [expect.objectContaining({ chatContext: { chatIdentifier: "trusted-alias" } })],
      [expect.objectContaining({ chatContext: { chatGuid: "iMessage;+;foreign" } })],
    ]);
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("rejects conflicting explicit aliases before provider reads", async () => {
    await expect(run("react", { ...message, chatIdentifier: "two", emoji: "👍" })).rejects.toThrow(
      "conflicting delivery target aliases",
    );
    expect(runtimeMock.resolveChatGuidForTarget).not.toHaveBeenCalled();
    expect(runtimeMock.authorizeMessageReference).not.toHaveBeenCalled();
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("requires sender ownership before unsending", async () => {
    bridge({ retractMessagePart: true });
    await run("unsend", message, { conversationReadOrigin: "direct-operator" });
    expect(runtimeMock.resolveIMessageMessageId.mock.calls).toEqual([
      ["message-guid", expect.objectContaining({ requireFromMe: true })],
      ["message-guid", expect.not.objectContaining({ requireFromMe: expect.anything() })],
    ]);
    expect(runtimeMock.authorizeMessageReference).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    );
    expect(runtimeMock.unsendMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves an explicit chat id without letting a fallback target change authority", async () => {
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved");
    await run("react", {
      chatId: 42,
      target: "chat_identifier:ignored",
      messageId: "message-guid",
      emoji: "👍",
    });
    expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
      [
        {
          target: { kind: "chat_id", chatId: 42 },
          options,
          conversationReadOrigin: "delegated",
        },
      ],
    ]);
    expect(runtimeMock.authorizeMessageReference.mock.calls).toEqual([
      [expect.objectContaining({ chatContext: { chatId: 42 } })],
      [expect.objectContaining({ chatContext: { chatGuid: "iMessage;+;resolved" } })],
    ]);
    expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;resolved",
          messageId: "message-guid",
          reaction: "like",
          remove: undefined,
          partIndex: undefined,
          options,
        },
      ],
    ]);
  });

  it("delivers hydrated URL-safe reply bytes with a default filename and caches the reply", async () => {
    attachmentBridge();
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");
    runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "reply-guid" });
    await run("reply", {
      chatIdentifier: "team-thread",
      messageId: "message-guid",
      text: "here it is",
      buffer: "-_8",
    });
    expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
      [
        {
          target: { kind: "chat_identifier", chatIdentifier: "team-thread" },
          options,
          conversationReadOrigin: "delegated",
        },
      ],
    ]);
    expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;resolved-ident",
          text: "here it is",
          replyToMessageId: "message-guid",
          partIndex: undefined,
          attachment: {
            kind: "buffer",
            buffer: Uint8Array.from([0xfb, 0xff]),
            filename: "attachment.bin",
          },
          options,
        },
      ],
    ]);
    expect(runtimeMock.authorizeMessageReference).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    );
    expect(rememberIMessageReplyCacheMock).toHaveBeenCalledWith({
      accountId: "default",
      messageId: "reply-guid",
      chatGuid: "iMessage;+;resolved-ident",
      timestamp: expect.any(Number),
      isFromMe: true,
    });
  });

  it("rejects reply paths that bypassed the outbound media resolver", async () => {
    attachmentBridge();
    for (const field of ["filePath", "path", "media", "mediaUrl", "fileUrl"]) {
      await expect(
        run("reply", { ...message, text: "reply", [field]: "/tmp/cute-lobster.png" }),
      ).rejects.toThrow(/did not pass through the outbound media resolver/);
    }
    expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
  });

  it("refuses to silently drop reply attachments on older imsg builds", async () => {
    attachmentBridge(false);
    await expect(
      run("reply", { ...message, text: "reply", buffer: "UE5HREFUQQ==", filename: "card.png" }),
    ).rejects.toThrow(/needs an imsg build that exposes `send-rich --file`/);
    expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
  });

  it("resolves a direct operator's phone target and short id before reacting", async () => {
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("any;-;+12069106512");
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("full-guid");
    await run(
      "react",
      { target: "+12069106512", messageId: "5", emoji: "👍" },
      { conversationReadOrigin: "direct-operator" },
    );
    expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
      [
        {
          target: { kind: "chat_identifier", chatIdentifier: "iMessage;-;+12069106512" },
          options,
          conversationReadOrigin: "direct-operator",
        },
      ],
    ]);
    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenNthCalledWith(1, "5", {
      requireKnownShortId: true,
      chatContext: {},
    });
    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenLastCalledWith("full-guid", {
      requireKnownShortId: true,
      chatContext: { chatGuid: "any;-;+12069106512" },
    });
    expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "any;-;+12069106512",
          messageId: "full-guid",
          reaction: "like",
          remove: undefined,
          partIndex: undefined,
          options,
        },
      ],
    ]);
  });

  it("rejects reactions to an unregistered synthesized chat", async () => {
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue(null);
    await expect(
      run("react", { target: "+19999999999", messageId: "irrelevant", emoji: "👍" }),
    ).rejects.toThrow(/requires a known chat/i);
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("allows a reply to create a new phone-number chat", async () => {
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue(null);
    runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });
    await run("reply", { target: "+18001234567", messageId: "parent-guid", text: "first contact" });
    expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;-;+18001234567",
          text: "first contact",
          replyToMessageId: "parent-guid",
          partIndex: undefined,
          attachment: undefined,
          options,
        },
      ],
    ]);
  });

  it("removes every tapback kind when the requested emoji is unknown", async () => {
    await run("react", { ...message, emoji: "🦞", remove: true });
    expect(runtimeMock.sendReaction.mock.calls.map(([call]) => call.reaction).toSorted()).toEqual(
      ["dislike", "emphasize", "laugh", "like", "love", "question"].toSorted(),
    );
    expect(runtimeMock.sendReaction.mock.calls.every(([call]) => call.remove)).toBe(true);
  });

  it("rejects unknown effects before sending", async () => {
    await expect(
      run("sendWithEffect", { chatGuid, text: "boom", effect: "invisible_ink" }),
    ).rejects.toThrow(/unknown effect|invisible_ink/i);
    expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
  });

  it("resolves an advertised screen-effect alias", async () => {
    runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });
    await run("sendWithEffect", { chatGuid, text: "boom", effect: "echo" });
    expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
      [
        {
          chatGuid,
          text: "boom",
          effectId: "com.apple.messages.effect.CKEchoEffect",
          options,
        },
      ],
    ]);
  });

  it("treats whitespace-only current channel ids as missing", async () => {
    await expect(
      run(
        "react",
        { messageId: "x", emoji: "👍" },
        {
          toolContext: { currentChannelId: "   \t  " },
        },
      ),
    ).rejects.toThrow(/requires chatGuid, chatId, chatIdentifier, or a chat target/);
  });

  it("uploads URL-safe attachment bytes as voice", async () => {
    runtimeMock.sendAttachment.mockResolvedValue({ messageId: "sent-guid" });
    const result = await run("upload-file", {
      chatGuid,
      filename: "photo.jpg",
      buffer: "-_8=",
      asVoice: true,
    });
    expect(runtimeMock.sendAttachment.mock.calls).toStrictEqual([
      [
        {
          chatGuid,
          buffer: Uint8Array.from([0xfb, 0xff]),
          filename: "photo.jpg",
          asVoice: true,
          options,
        },
      ],
    ]);
    expect(result?.details).toEqual({ ok: true, messageId: "sent-guid" });
  });

  it("sets a group icon from hydrated bytes for its owner", async () => {
    await run(
      "setGroupIcon",
      { chatGuid, buffer: "-_8", filename: "photo.jpg" },
      { senderIsOwner: true },
    );
    expect(runtimeMock.setGroupIcon).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: Uint8Array.from([0xfb, 0xff]) }),
    );
  });

  it("rejects malformed reply bytes before sending", async () => {
    attachmentBridge();
    await expect(
      run("reply", {
        ...message,
        text: "here it is",
        buffer: "!!!not-base64!!!",
        filename: "card.png",
      }),
    ).rejects.toThrow(/must be valid base64/);
    expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
  });
});
