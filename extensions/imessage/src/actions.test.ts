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
// mock-isolation: keep private API probe calls in the test-owned double.
vi.mock("./probe.js", () => ({
  probeIMessagePrivateApi: probeMock.probeIMessagePrivateApi,
}));
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
const connection = { cliPath: "imsg", dbPath: "/tmp/messages.db" };
const voteStatus = {
  available: true,
  v2Ready: true,
  selectors: { pollVoteMessage: true },
  rpcMethods: ["send", "poll.send", "poll.vote"],
};
const byteShape = expect.objectContaining({ 0: 0xfb, 1: 0xff, byteLength: 2 });
const refreshOptions = ["imsg", 10_000, { forceRefresh: true }] as const;
const readyStatus = { available: true, v2Ready: true, selectors: {} };

function expectCall(mock: { mock: { calls: unknown[][] } }, params: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(params));
}

function expectOwnedReference() {
  expect(runtimeMock.resolveIMessageMessageId.mock.calls).toEqual([
    ["message-guid", expect.objectContaining({ requireFromMe: true })],
    ["message-guid", expect.not.objectContaining({ requireFromMe: expect.anything() })],
  ]);
}

function expectAuthorization(messageId = "message-guid", conversationReadOrigin = "delegated") {
  expect(runtimeMock.authorizeMessageReference).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "default", messageId, conversationReadOrigin }),
  );
}

function cfg(actions?: Record<string, boolean | undefined>): OpenClawConfig {
  return { channels: { imessage: { ...connection, actions } } };
}
function bridge(selectors: Record<string, boolean> = {}) {
  probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({ ...readyStatus, selectors });
}
function attachmentBridge(supported = true) {
  probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
    ...readyStatus,
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
  it("requires a trusted requester for iMessage group management", () => {
    const requiresTrusted = (
      action: ChannelMessageActionContext["action"],
      provider = "imessage",
    ) =>
      imessageMessageActions.requiresTrustedRequesterSender?.({
        action,
        toolContext: { currentChannelProvider: provider },
      });
    for (const action of [
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
    ] as const) {
      expect(requiresTrusted(action)).toBe(true);
    }
    expect(requiresTrusted("renameGroup", "discord")).toBe(false);
    expect(requiresTrusted("react")).toBe(false);
  });

  it("rejects group management before native mutation without owner or admin authority", async () => {
    await expect(
      run(
        "renameGroup",
        { chatGuid, name: "Unauthorized rename" },
        { senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
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
    expectCall(runtimeMock.renameGroup, { chatGuid, displayName: "Renamed group" });
    expectCall(runtimeMock.leaveGroup, { chatGuid });
  });

  it("refreshes stale capabilities and sends a normalized current-conversation poll", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      ...voteStatus,
      selectors: {},
      rpcMethods: ["send"],
    });
    probeMock.probeIMessagePrivateApi.mockResolvedValue({
      ...readyStatus,
      selectors: { pollPayloadMessage: true },
      rpcMethods: ["send", "poll.send"],
    });
    runtimeMock.sendPoll.mockResolvedValue({ messageId: "poll-guid" });
    const result = await run(
      "poll",
      { pollQuestion: "  Lunch?  ", pollOption: [" Pizza ", "Sushi", ""] },
      { toolContext: { currentChannelId: "chat_guid:" + chatGuid } },
    );
    expect(probeMock.probeIMessagePrivateApi).toHaveBeenCalledWith(...refreshOptions);
    expectCall(runtimeMock.sendPoll, { chatGuid, question: "Lunch?", choices: ["Pizza", "Sushi"] });
    expect(result).toMatchObject({ details: { ok: true, messageId: "poll-guid" } });
  });

  it("rejects a redacted target before sending", async () => {
    bridge({ pollPayloadMessage: true });
    await expect(
      run(
        "poll",
        { target: "***", pollQuestion: "Lunch?", pollOption: ["Pizza", "Sushi"] },
        { toolContext: { currentChannelId: "chat_guid:" + chatGuid } },
      ),
    ).rejects.toThrow("Omit the target to use the current conversation");
    expect(runtimeMock.sendPoll).not.toHaveBeenCalled();
  });

  it.each([
    [{ pollOptionIndex: 2 }, { optionIndex: 2 }],
    [{ pollId: "3", pollOptionText: "Blue" }, { optionText: "Blue" }],
  ])("resolves and authorizes the poll with selector %j", async (params, selector) => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(voteStatus);
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("poll-full-guid");
    runtimeMock.sendPollVote.mockResolvedValue({ messageId: "vote-guid", optionText: "Blue" });
    const result = await run(
      "poll-vote",
      { chatGuid, ...params },
      { toolContext: { currentMessageId: 3 }, conversationReadOrigin: "delegated" },
    );
    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenCalledWith(
      "3",
      expect.objectContaining({ chatContext: { chatGuid } }),
    );
    expectAuthorization("poll-full-guid");
    expectCall(runtimeMock.sendPollVote, {
      chatGuid,
      pollGuid: "poll-full-guid",
      ...selector,
    });
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
      "poll",
      { ...readyStatus, rpcMethods: ["send", "poll.send"] },
      /pollPayloadMessage selector.*imsg launch/,
    ],
    [
      "poll-vote",
      { ...voteStatus, rpcMethods: ["send", "poll.send", "messages.poll.send"] },
      /poll.vote capability/,
    ],
    [
      "poll-vote",
      { ...voteStatus, selectors: { pollPayloadMessage: true } },
      /pollVoteMessage selector.*imsg launch/,
    ],
  ] as const)("rejects missing %s capability %j after refresh", async (action, stale, error) => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(stale);
    probeMock.probeIMessagePrivateApi.mockResolvedValue(stale);
    const params = action === "poll" ? poll : { chatGuid, pollId: "3", pollOptionIndex: 2 };
    await expect(run(action, params)).rejects.toThrow(error);
    expect(probeMock.probeIMessagePrivateApi).toHaveBeenCalledWith(...refreshOptions);
    expect(
      action === "poll" ? runtimeMock.sendPoll : runtimeMock.sendPollVote,
    ).not.toHaveBeenCalled();
  });

  it("authorizes edits and uses the detected remote transport", async () => {
    const text = "spaces ; $(touch /tmp/nope) `whoami` & |";
    const remote = { cliPath: "/gateway/imsg-ssh", dbPath: "~/Library/Messages/chat.db" };
    bridge({ editMessage: true });
    remoteHostMock.resolve.mockResolvedValue("bot@messages-mac");
    await run("edit", { ...message, text }, { cfg: { channels: { imessage: remote } } });
    expectOwnedReference();
    expectAuthorization();
    expect(runtimeMock.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text,
        options: expect.objectContaining({
          ...remote,
          remoteHost: "bot@messages-mac",
        }),
      }),
    );
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
      /iMessage react blocked: private API bridge unavailable.*imsg launch/s,
    );
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign-chat", "foreign-guid", undefined],
    ["trusted-alias", "message-guid", "iMessage;+;foreign"],
  ] as const)(
    "rejects unauthorized alias %s / %s / %s",
    async (chatIdentifier, messageId, resolved) => {
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue(resolved);
      runtimeMock.authorizeMessageReference.mockImplementation(({ chatContext }) => {
        if (!resolved || chatContext.chatGuid) {
          throw new Error("iMessage message reference belongs to a different conversation.");
        }
      });
      await expect(run("react", { chatIdentifier, messageId, emoji: "👍" })).rejects.toThrow(
        "different conversation",
      );
      const contexts = [{ chatIdentifier }, ...(resolved ? [{ chatGuid: resolved }] : [])];
      expect(runtimeMock.authorizeMessageReference.mock.calls).toEqual(
        contexts.map((chatContext) => [expect.objectContaining({ chatContext })]),
      );
      if (!resolved) {
        expect(runtimeMock.resolveChatGuidForTarget).not.toHaveBeenCalled();
      }
      expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "disabled",
      { ...message, emoji: "👍" },
      { cfg: cfg({ reactions: false }) },
      /disabled in config/i,
    ],
    [
      "conflicting",
      { ...message, chatIdentifier: "two", emoji: "👍" },
      {},
      /conflicting delivery target aliases/,
    ],
    [
      "missing",
      { messageId: "x", emoji: "👍" },
      { toolContext: { currentChannelId: "   \t  " } },
      /requires chatGuid, chatId, chatIdentifier, or a chat target/,
    ],
  ] as const)("rejects %s reaction inputs", async (kind, params, context, error) => {
    await expect(run("react", params, context)).rejects.toThrow(error);
    if (kind === "conflicting") {
      expect(runtimeMock.resolveChatGuidForTarget).not.toHaveBeenCalled();
      expect(runtimeMock.authorizeMessageReference).not.toHaveBeenCalled();
    }
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("requires sender ownership before unsending", async () => {
    bridge({ retractMessagePart: true });
    await run("unsend", message, { conversationReadOrigin: "direct-operator" });
    expectOwnedReference();
    expectAuthorization("message-guid", "direct-operator");
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
    expectCall(runtimeMock.resolveChatGuidForTarget, {
      target: { kind: "chat_id", chatId: 42 },
      conversationReadOrigin: "delegated",
    });
    expect(runtimeMock.authorizeMessageReference.mock.calls).toEqual([
      [expect.objectContaining({ chatContext: { chatId: 42 } })],
      [expect.objectContaining({ chatContext: { chatGuid: "iMessage;+;resolved" } })],
    ]);
    expectCall(runtimeMock.sendReaction, {
      chatGuid: "iMessage;+;resolved",
      messageId: "message-guid",
      reaction: "like",
    });
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
    expectCall(runtimeMock.resolveChatGuidForTarget, {
      target: { kind: "chat_identifier", chatIdentifier: "team-thread" },
      conversationReadOrigin: "delegated",
    });
    expectCall(runtimeMock.sendRichMessage, {
      chatGuid: "iMessage;+;resolved-ident",
      text: "here it is",
      replyToMessageId: "message-guid",
      attachment: { kind: "buffer", buffer: byteShape, filename: "attachment.bin" },
    });
    expectAuthorization();
    expect(rememberIMessageReplyCacheMock).toHaveBeenCalledWith({
      accountId: "default",
      messageId: "reply-guid",
      chatGuid: "iMessage;+;resolved-ident",
      timestamp: expect.any(Number),
      isFromMe: true,
    });
  });

  it.each([
    ...["filePath", "path", "media", "mediaUrl", "fileUrl"].map((field) => ({
      params: { [field]: "/tmp/cute-lobster.png" },
      supported: true,
      error: /did not pass through the outbound media resolver/,
    })),
    {
      params: { buffer: "UE5HREFUQQ==", filename: "card.png" },
      supported: false,
      error: /needs an imsg build that exposes `send-rich --file`/,
    },
    {
      params: { buffer: "!!!not-base64!!!", filename: "card.png" },
      supported: true,
      error: /must be valid base64/,
    },
  ])("rejects unsafe reply attachment $params", async ({ params, supported, error }) => {
    attachmentBridge(supported);
    await expect(run("reply", { ...message, text: "reply", ...params })).rejects.toThrow(error);
    expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
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
    expectCall(runtimeMock.sendRichMessage, {
      chatGuid: "iMessage;-;+18001234567",
      text: "first contact",
      replyToMessageId: "parent-guid",
    });
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
    expectCall(runtimeMock.sendRichMessage, {
      chatGuid,
      text: "boom",
      effectId: "com.apple.messages.effect.CKEchoEffect",
    });
  });

  it("uploads URL-safe attachment bytes as voice", async () => {
    runtimeMock.sendAttachment.mockResolvedValue({ messageId: "sent-guid" });
    const result = await run("upload-file", {
      chatGuid,
      filename: "photo.jpg",
      buffer: "-_8=",
      asVoice: true,
    });
    expectCall(runtimeMock.sendAttachment, {
      chatGuid,
      buffer: byteShape,
      filename: "photo.jpg",
      asVoice: true,
    });
    expect(result?.details).toEqual({ ok: true, messageId: "sent-guid" });
  });

  it("sets a group icon from hydrated bytes for its owner", async () => {
    await run(
      "setGroupIcon",
      { chatGuid, buffer: "-_8", filename: "photo.jpg" },
      { senderIsOwner: true },
    );
    expect(runtimeMock.setGroupIcon).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: byteShape }),
    );
  });
});
