import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { sendSlackMessage as sendSlackMessageThroughPublicOwner } from "./actions.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import type { SlackSendResult } from "./send.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const originalSlackActionRuntime = { ...slackActionRuntime };
const createSlackChannel = vi.fn(async (..._args: unknown[]) => ({
  channelId: "C456",
  name: "proj-channel-create-proof",
  target: "team:T123:channel:C456",
}));
const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const downloadSlackFile = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackEmojis = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackPins = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackReactions = vi.fn(async (..._args: unknown[]) => ({}));
const pinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const reactSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const readSlackMessages = vi.fn(async (..._args: unknown[]) => ({}));
const removeOwnSlackReactions = vi.fn(async (..._args: unknown[]) => ["thumbsup"]);
const removeSlackReaction = vi.fn(async (..._args: unknown[]) => ({}));
const resolveSlackConversationName = vi.fn(
  async (..._args: unknown[]): Promise<string | undefined> => undefined,
);
const resolveSlackConversationInfo = vi.fn(
  async (params: {
    cfg: OpenClawConfig;
    channelId: string;
    requireFreshName?: boolean;
  }): Promise<{ type: "channel" | "group" | "dm" | "unknown"; name?: string; user?: string }> => {
    if (/^D/i.test(params.channelId)) {
      return { type: "dm", user: "U123" };
    }
    if (/^G/i.test(params.channelId)) {
      return { type: "group" };
    }
    const slackConfig = params.cfg.channels?.slack as
      | { userToken?: string; botToken?: string; channels?: Record<string, unknown> }
      | undefined;
    const token = slackConfig?.userToken ?? slackConfig?.botToken;
    const tokenOverride = token && token !== slackConfig?.botToken ? { token } : {};
    const channelName = params.requireFreshName
      ? await resolveSlackConversationName(params.channelId, {
          cfg: params.cfg,
          ...tokenOverride,
        })
      : undefined;
    return { type: "channel", ...(channelName ? { name: channelName } : {}) };
  },
);
const sendSlackMessage = vi.fn(
  async (..._args: unknown[]): Promise<Partial<SlackSendResult> & { channelId: string }> => ({
    channelId: "C123",
  }),
);
const unpinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

describe("handleSlackAction", () => {
  let cfg: OpenClawConfig;
  const message = { channelId: "C123", messageId: "123.456" };
  const send = { action: "sendMessage", to: "channel:C123" };
  const upload = { action: "uploadFile", to: "channel:C123", filePath: "/tmp/report.png" };
  function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return { channels: { slack: { botToken: "tok", ...overrides } } };
  }

  function namedPolicy(overrides?: Record<string, unknown>) {
    return slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: { "#allowed-channel": { enabled: true } },
      ...overrides,
    });
  }

  const trustedContext = {
    currentChannelProvider: "slack",
    currentChannelId: "team:T123:channel:C123",
    requesterAccountId: "default",
  };

  it("reads normalized pins from the trusted current workspace", async () => {
    listSlackPins.mockResolvedValueOnce([{ message: { ts: "1712345678.123456", text: "pin" } }]);
    const result = await handleSlackAction(
      { action: "listPins", channelId: "C123" },
      cfg,
      trustedContext,
    );
    expect(listSlackPins).toHaveBeenCalledWith("C123", { cfg, teamId: "T123" });
    expect(result.details).toMatchObject({
      ok: true,
      pins: [{ message: { ts: "1712345678.123456", text: "pin", timestampMs: 1712345678123 } }],
    });
  });

  it("rejects a bare detached target for an authenticated Enterprise install", async () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(
        handleSlackAction({ action: "react", ...message, emoji: "thumbsup" }, cfg),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      expect(reactSlackMessage).not.toHaveBeenCalled();
    } finally {
      installationState.release();
    }
  });

  it("reads the current requester from the trusted current workspace", async () => {
    const info = { ok: true, user: { id: "U123", is_bot: false } };
    getSlackMemberInfo.mockResolvedValueOnce(info);
    const result = await handleSlackAction({ action: "memberInfo", userId: "U123" }, cfg, {
      ...trustedContext,
      requesterSenderId: "U123",
    });
    expect(getSlackMemberInfo).toHaveBeenCalledWith("U123", { cfg, teamId: "T123" });
    expect(result.details).toEqual({ ok: true, info });
  });

  it("adds the trusted Slack requester to a created channel", async () => {
    const result = await handleSlackAction(
      { action: "createChannel", name: "proj-channel-create-proof" },
      cfg,
      { ...trustedContext, requesterSenderId: "U456" },
    );

    expect(createSlackChannel).toHaveBeenCalledWith("proj-channel-create-proof", {
      cfg,
      teamId: "T123",
      inviteUserId: "U456",
    });
    expect(result.details).toMatchObject({ ok: true, target: "team:T123:channel:C456" });
  });

  it.each([
    { name: "an unqualified conversation", context: { currentChannelId: "C123" } },
    {
      name: "conflicting current workspaces",
      context: {
        currentChannelId: "team:T123:channel:C123",
        currentMessagingTarget: "team:T999:channel:C123",
      },
    },
  ])("rejects Enterprise metadata reads with $name", async ({ context }) => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      for (const action of ["memberInfo", "emojiList"]) {
        await expect(
          handleSlackAction({ action, userId: "U123" }, cfg, {
            ...context,
            currentChannelProvider: "slack",
            requesterAccountId: "default",
            requesterSenderId: "U123",
          }),
        ).rejects.toThrow("unsupported_enterprise_slack_delivery");
      }
      expect(getSlackMemberInfo).not.toHaveBeenCalled();
      expect(listSlackEmojis).not.toHaveBeenCalled();
    } finally {
      installationState.release();
    }
  });

  it("scopes every message and pin write to the trusted current workspace", async () => {
    await handleSlackAction({ ...send, content: "created" }, cfg, trustedContext);
    await handleSlackAction(
      { action: "editMessage", ...message, content: "updated" },
      cfg,
      trustedContext,
    );
    for (const action of ["deleteMessage", "pinMessage", "unpinMessage"]) {
      await handleSlackAction(
        { action, channelId: "C123", messageId: "123.456" },
        cfg,
        trustedContext,
      );
    }
    expectSlackSendCall(0, "team:T123:channel:C123", "created", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
    expect(editSlackMessage).toHaveBeenCalledWith("C123", "123.456", "updated", {
      cfg,
      teamId: "T123",
      blocks: undefined,
    });
    for (const operation of [deleteSlackMessage, pinSlackMessage, unpinSlackMessage]) {
      expect(operation).toHaveBeenCalledWith("C123", "123.456", { cfg, teamId: "T123" });
    }
  });

  it("scopes history, file, reaction, and emoji reads to the trusted workspace", async () => {
    readSlackMessages.mockResolvedValueOnce({
      messages: [{ ts: "1712345678.123456", text: "hi" }],
      hasMore: false,
    });
    listSlackReactions.mockResolvedValueOnce([]);
    downloadSlackFile.mockResolvedValueOnce(null);
    listSlackEmojis.mockResolvedValueOnce({ ok: true, emoji: { openai: "url" } });
    const history = await handleSlackAction(
      {
        action: "readMessages",
        channelId: "C123",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
        limit: "20",
      },
      cfg,
      trustedContext,
    );
    await handleSlackAction(
      { action: "reactions", channelId: "C123", messageId: "123.456" },
      cfg,
      trustedContext,
    );
    await handleSlackAction(
      { action: "downloadFile", channelId: "C123", fileId: "F123" },
      cfg,
      trustedContext,
    );
    await handleSlackAction({ action: "emojiList" }, cfg, trustedContext);
    expect(readSlackMessages).toHaveBeenCalledWith("C123", {
      cfg,
      teamId: "T123",
      limit: 20,
      before: undefined,
      after: undefined,
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
    expect(history.details).toMatchObject({
      ok: true,
      channelId: "C123",
      threadId: "1712345678.123456",
      hasMore: false,
      messages: [{ ts: "1712345678.123456", timestampMs: 1712345678123 }],
    });
    expect(listSlackReactions).toHaveBeenCalledWith("C123", "123.456", { cfg, teamId: "T123" });
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        cfg,
        teamId: "T123",
        channelId: "C123",
      }),
    );
    expect(listSlackEmojis).toHaveBeenCalledWith({ cfg, teamId: "T123" });
  });

  function createReplyToFirstContext(
    hasRepliedRef = { value: false },
  ): SlackActionContext & { hasRepliedRef: { value: boolean } } {
    return {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
      hasRepliedRef,
    };
  }

  const requireRecord = createRequireRecord("object", "label-not-object");

  function expectSlackSendCall(
    index: number,
    target: string,
    content: string,
    optionFields: Record<string, unknown>,
  ) {
    const call = sendSlackMessage.mock.calls[index];
    expect(call).toEqual([target, content, expect.objectContaining(optionFields)]);
    return requireRecord(call?.[2], "Slack send options");
  }

  function expectLastSlackSend(content: string, config: OpenClawConfig, threadTs?: string) {
    expectSlackSendCall(sendSlackMessage.mock.calls.length - 1, "channel:C123", content, {
      cfg: config,
      mediaUrl: undefined,
      threadTs,
      blocks: undefined,
    });
  }

  function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
    return requireRecord(result.details, "action result details");
  }

  async function sendSecondMessageAndExpectNoThread(params: {
    cfg: OpenClawConfig;
    context: SlackActionContext;
  }) {
    await handleSlackAction({ ...send, content: "Second" }, params.cfg, params.context);
    expectLastSlackSend("Second", params.cfg);
  }

  it("fails closed for thread-required contexts without a thread timestamp", async () => {
    await expect(
      handleSlackAction({ ...send, content: "keep private" }, slackConfig(), {
        currentChannelId: "C123",
        replyToMode: "all",
        sameChannelThreadRequired: true,
      }),
    ).rejects.toThrow("Slack thread context is required");
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it("allows explicit top-level sends from thread-required contexts", async () => {
    await handleSlackAction({ ...send, content: "root", topLevel: true }, cfg, {
      currentChannelId: "C123",
      replyToMode: "all",
      sameChannelThreadRequired: true,
    });
    expectLastSlackSend("root", cfg);
  });

  it("forwards preformatted fallback text and trusted forced-media access for user identity", async () => {
    cfg = slackConfig({ postAs: "user", userToken: "test-user-token" });
    const mediaAccess = {
      localRoots: ["/tmp/workspace-agent"],
      readFile: vi.fn(async () => Buffer.from("image")),
      workspaceDir: "/tmp/workspace-agent",
    };
    await handleSlackAction(
      {
        ...send,
        content: "- Account: &lt;@U123&gt;",
        mediaUrl: "https://example.com/report.csv",
        textIsSlackMrkdwn: true,
        forceDocument: true,
      },
      cfg,
      { mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
    );
    const options = expectSlackSendCall(0, "channel:C123", "- Account: &lt;@U123&gt;", {
      cfg,
      token: "test-user-token",
      mediaUrl: "https://example.com/report.csv",
      textIsSlackMrkdwn: true,
      forceDocument: true,
      blocks: undefined,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile: undefined,
    });
    expect(options.mediaAccess).toBe(mediaAccess);
    expect(sendSlackMessage).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    cfg = slackConfig();
    vi.clearAllMocks();
    resolveSlackConversationName.mockReset().mockResolvedValue(undefined);
    resolveSlackConversationInfo.mockClear();
    Object.assign(slackActionRuntime, originalSlackActionRuntime, {
      createSlackChannel,
      deleteSlackMessage,
      downloadSlackFile,
      editSlackMessage,
      getSlackMemberInfo,
      listSlackEmojis,
      listSlackPins,
      listSlackReactions,
      parseSlackBlocksInput,
      pinSlackMessage,
      reactSlackMessage,
      readSlackMessages,
      removeOwnSlackReactions,
      removeSlackReaction,
      resolveSlackConversationInfo,
      sendSlackMessage,
      unpinSlackMessage,
    });
  });

  it("qualifies a bare reaction target from the trusted current conversation", async () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      const result = await handleSlackAction(
        { action: "react", channelId: "channel:c08gqh53ejm", messageId: "123.456", emoji: "✅" },
        cfg,
        { ...trustedContext, currentChannelId: "team:T123:channel:C08GQH53EJM" },
      );

      expect(result.details).toEqual({ ok: true, added: "✅" });
      expect(reactSlackMessage).toHaveBeenCalledWith("C08GQH53EJM", "123.456", "✅", {
        cfg,
        teamId: "T123",
      });
    } finally {
      installationState.release();
    }
  });

  it.each([
    ["provider", { currentChannelProvider: "discord" }],
    ["account", { requesterAccountId: "other" }],
    ["workspace", { currentMessagingTarget: "team:T456:channel:C123" }],
  ] as const)("does not infer a workspace from conflicting %s context", async (_, patch) => {
    await handleSlackAction({ action: "react", ...message, emoji: "✅" }, cfg, {
      ...trustedContext,
      ...patch,
    });
    expect(reactSlackMessage).toHaveBeenCalledWith("C123", "123.456", "✅", { cfg });
  });

  it("removes a reaction in the explicitly selected workspace", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "team:T123:channel:C123",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C123", "123.456", "✅", {
      cfg,
      teamId: "T123",
    });
  });

  it("removes own reactions on empty emoji", async () => {
    await handleSlackAction(
      { action: "react", channelId: "C1", messageId: "123.456", emoji: "" },
      cfg,
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456", { cfg });
  });

  it("respects reaction gating", async () => {
    await expect(
      handleSlackAction(
        { action: "react", ...message, emoji: "✅" },
        slackConfig({ actions: { reactions: false } }),
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
    expect(reactSlackMessage).not.toHaveBeenCalled();
  });

  it("fails closed for downloadFile when no channel target can be authorized", async () => {
    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123" }, slackConfig()),
    ).rejects.toThrow(
      "Slack file download requires channelId or to so the read target can be authorized.",
    );
    expect(downloadSlackFile).not.toHaveBeenCalled();
  });

  it("authorizes a context-only download and reports unavailable attachments", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    cfg = slackConfig({ groupPolicy: "allowlist", channels: { C_ALLOWED: { enabled: true } } });
    const result = await handleSlackAction({ action: "downloadFile", fileId: "F123" }, cfg, {
      currentChannelId: "C_ALLOWED",
    });
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        channelId: "C_ALLOWED",
        token: "tok",
        maxBytes: 20 * 1024 * 1024,
      }),
    );
    expect(result.details).toMatchObject({
      ok: false,
      error: expect.stringMatching(/requested Slack channel or explicit thread/i),
    });
  });

  it("returns non-image downloadFile results as file metadata instead of image content", async () => {
    downloadSlackFile.mockResolvedValueOnce({
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
      placeholder: "[Slack file: report.pdf (fileId: F123)]",
    });

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        to: "channel:C1",
        replyTo: "123.456",
      },
      slackConfig({ accounts: { default: { botToken: "xoxb-bot", userToken: "xoxp-user" } } }),
    );

    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        channelId: "C1",
        threadId: "123.456",
        token: "xoxp-user",
      }),
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/tmp/openclaw-media/report.pdf"),
    });
    const details = requireDetails(result);
    expect(details).toMatchObject({
      ok: true,
      fileId: "F123",
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
    });
    expect(details.media).toEqual({
      mediaUrl: "/tmp/openclaw-media/report.pdf",
      outbound: false,
      contentType: "application/pdf",
    });
  });

  it("requires a send payload", async () => {
    await expect(handleSlackAction({ ...send, content: "" }, cfg)).rejects.toThrow(
      /requires content, blocks, or mediaUrl/i,
    );
  });

  it("requires edit content or blocks", async () => {
    await expect(
      handleSlackAction({ action: "editMessage", ...message, content: "" }, cfg),
    ).rejects.toThrow(/requires content or blocks/i);
  });

  it("uploads metadata and original media through the trusted workspace using a writable user token", async () => {
    cfg = {
      channels: {
        slack: {
          accounts: { default: { userToken: "xoxp-user", userTokenReadOnly: false } },
        },
      },
    };
    await handleSlackAction(
      {
        ...upload,
        initialComment: "fresh report",
        filename: "report-final.png",
        title: "Report Final",
        threadTs: "111.222",
        forceDocument: true,
      },
      cfg,
      trustedContext,
    );
    expectSlackSendCall(0, "team:T123:channel:C123", "fresh report", {
      cfg,
      token: "xoxp-user",
      mediaUrl: "/tmp/report.png",
      threadTs: "111.222",
      uploadFileName: "report-final.png",
      uploadTitle: "Report Final",
      forceDocument: true,
    });
  });

  it("rejects replyBroadcast for uploadFile", async () => {
    await expect(
      handleSlackAction({ ...upload, threadTs: "111.222", replyBroadcast: true }, slackConfig()),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it.each([false, true])("sends media before separate blocks (prepared=%s)", async (prepared) => {
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "F123" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.456" });

    const result = await handleSlackAction(
      {
        ...send,
        content: "",
        mediaUrl: "https://example.com/file.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      cfg,
      prepared ? { preparedMessages: [{ text: "", blocks: [{ type: "divider" }] }] } : undefined,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: "https://example.com/file.png",
      threadTs: undefined,
    });
    expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
      "blocks",
    );
    expectSlackSendCall(1, "channel:C123", "", {
      cfg,
      blocks: [{ type: "divider" }],
      threadTs: undefined,
    });
    expect(requireRecord(sendSlackMessage.mock.calls[1]?.[2], "send options")).not.toHaveProperty(
      "mediaUrl",
    );
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        ...message,
        receipt: { platformMessageIds: ["F123", "123.456"] },
      },
    });
  });

  it("keeps oversized text and native blocks in the same resolved thread", async () => {
    cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    const content = "x".repeat(8001);
    const blocks = [{ type: "divider" }];
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.456" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.457" });

    const result = await handleSlackAction(
      { ...send, content, blocks, replyBroadcast: true },
      cfg,
      context,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      blocks,
      threadTs: "1111111111.111111",
    });
    expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
      "replyBroadcast",
    );
    const textOptions = expectSlackSendCall(1, "channel:C123", content, {
      cfg,
      replyBroadcast: true,
      threadTs: "1111111111.111111",
    });
    expect(textOptions).not.toHaveProperty("blocks");
    expect(hasRepliedRef.value).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        channelId: "C123",
        messageId: "123.457",
        receipt: { platformMessageIds: ["123.456", "123.457"] },
      },
    });
  });

  it("keeps overlong native-data accessibility and blocks in one send", async () => {
    const content = `Pipeline summary\n\n${"x".repeat(8001)}`;
    const blocks = [
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
    ];

    await handleSlackAction(
      {
        ...send,
        content,
        blocks,
        nativeDataFallbackBaseText: "Pipeline summary",
      },
      cfg,
    );

    expect(sendSlackMessage).toHaveBeenCalledOnce();
    expectSlackSendCall(0, "channel:C123", content, {
      cfg,
      blocks,
      nativeDataFallbackBaseText: "Pipeline summary",
      threadTs: undefined,
    });
  });

  it("delivers a prepared presentation plan in order on one resolved thread", async () => {
    const chartBlocks = [
      { type: "data_visualization", title: "Revenue", chart: {} },
      { type: "actions", elements: [{ type: "button", action_id: "question-choice" }] },
    ];
    const hasRepliedRef = { value: false };
    for (const [index, ids] of [["123.456"], ["123.457", "123.458"]].entries()) {
      sendSlackMessage.mockResolvedValueOnce({
        channelId: "C123",
        messageId: ids.at(-1),
        ...(index === 0 ? { meta: { slackQuestionActionIds: ["question-choice"] } } : {}),
        receipt: {
          platformMessageIds: ids,
          primaryPlatformMessageId: ids[0],
          parts: ids.map((platformMessageId, partIndex) => ({
            platformMessageId,
            kind: index === 1 ? "text" : "card",
            index: partIndex,
            threadId: "1111111111.111111",
          })),
          threadId: "1111111111.111111",
          sentAt: 123,
        },
      });
    }

    const result = await handleSlackAction(
      { ...send, content: "", blocks: chartBlocks, replyBroadcast: true },
      cfg,
      {
        ...createReplyToFirstContext(hasRepliedRef),
        preparedMessages: [
          { text: "Revenue", blocks: chartBlocks, authoredTextPlacement: "blocks" },
          { text: "Wide table fallback", textIsSlackPlainText: true },
        ],
      },
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "Revenue", {
      cfg,
      blocks: chartBlocks,
      authoredTextPlacement: "blocks",
      replyBroadcast: true,
      threadTs: "1111111111.111111",
    });
    expectSlackSendCall(1, "channel:C123", "Wide table fallback", {
      cfg,
      textIsSlackPlainText: true,
      threadTs: "1111111111.111111",
    });
    expect(hasRepliedRef.value).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        channelId: "C123",
        messageId: "123.458",
        meta: {
          slackQuestionActionIds: ["question-choice"],
          slackQuestionMessageId: "123.456",
        },
        receipt: {
          primaryPlatformMessageId: "123.456",
          platformMessageIds: ["123.456", "123.457", "123.458"],
          parts: [
            { platformMessageId: "123.456", kind: "card", index: 0 },
            { platformMessageId: "123.457", kind: "text", index: 1 },
            { platformMessageId: "123.458", kind: "text", index: 2 },
          ],
          threadId: "1111111111.111111",
          sentAt: 123,
        },
      },
    });
  });

  it("edits blocks without requiring text", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "updated" } }];
    await handleSlackAction({ action: "editMessage", ...message, blocks }, cfg);
    expect(editSlackMessage).toHaveBeenCalledWith("C123", "123.456", "", { cfg, blocks });
  });

  it("keeps the batched reply thread available after a failed upload", async () => {
    cfg = slackConfig({ replyToMode: "batched" });
    const context = { ...createReplyToFirstContext(), replyToMode: "batched" as const };
    const params = {
      action: "uploadFile",
      to: "channel:C123",
      filePath: "/tmp/report.txt",
      initialComment: "First",
    };
    sendSlackMessage.mockRejectedValueOnce(new Error("Slack transport failed"));
    await expect(handleSlackAction(params, cfg, context)).rejects.toThrow("Slack transport failed");
    expect(context.hasRepliedRef.value).toBe(false);
    await handleSlackAction(params, cfg, context);
    for (const index of [0, 1]) {
      expectSlackSendCall(index, "channel:C123", "First", { cfg, threadTs: "1111111111.111111" });
    }
    expect(context.hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("records an accepted batched Slack text chunk when the next platform post fails", async () => {
    const context = { ...createReplyToFirstContext(), replyToMode: "batched" as const };
    const client = new WebClient("xoxb-test", { retryConfig: { retries: 0 } });
    vi.spyOn(client.chat, "postMessage")
      .mockResolvedValueOnce({ ok: true, channel: "C123", ts: "1111111111.111112" })
      .mockRejectedValueOnce(new Error("Second Slack text chunk failed"));
    sendSlackMessage.mockImplementationOnce(async (...args) => {
      const [target, content, options] = args;
      if (typeof target !== "string" || typeof content !== "string") {
        throw new Error("Expected a Slack target and text");
      }
      return await sendSlackMessageThroughPublicOwner(target, content, {
        ...requireRecord(options, "Slack send options"),
        cfg,
        client,
      });
    });

    await expect(
      handleSlackAction({ ...send, content: "a".repeat(8500) }, cfg, context),
    ).rejects.toThrow("Second Slack text chunk failed");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(context.hasRepliedRef.value).toBe(true);
  });

  it("keeps concurrent first replies threaded until a delivery succeeds", async () => {
    cfg = slackConfig({ replyToMode: "first" });
    const context = createReplyToFirstContext();
    const firstDelivery = createDeferred<{ channelId: string }>();
    const started = createDeferred<void>();
    sendSlackMessage.mockImplementationOnce(() => {
      started.resolve();
      return firstDelivery.promise;
    });
    const firstAttempt = handleSlackAction({ ...send, content: "Pending" }, cfg, context);
    await started.promise;
    expect(sendSlackMessage).toHaveBeenCalledOnce();
    await handleSlackAction({ ...send, content: "Accepted" }, cfg, context);
    expectSlackSendCall(1, "channel:C123", "Accepted", { cfg, threadTs: "1111111111.111111" });
    expect(context.hasRepliedRef.value).toBe(true);
    firstDelivery.reject(new Error("First Slack delivery failed"));
    await expect(firstAttempt).rejects.toThrow("First Slack delivery failed");
    expect(context.hasRepliedRef.value).toBe(true);
  });

  it("preserves a prepared channel override that disables auto-threading", async () => {
    const context = buildSlackThreadingToolContext({
      cfg: slackConfig({ replyToMode: "all", channels: { C123: { replyToMode: "off" } } }),
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
        ReplyToId: "1111111111.111111",
        ReplyToMode: "off",
      },
    });
    await handleSlackAction({ ...send, content: "Channel root" }, cfg, context);
    expectLastSlackSend("Channel root", cfg);
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    await handleSlackAction({ ...send, to: "#c123", content: "No ref" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
    });
    expectSlackSendCall(0, "#c123", "No ref", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("resolves name-allowlisted reads from a core-shaped Slack threading context", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("allowed-channel");
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    cfg = namedPolicy({
      userToken: "xoxp-reader",
      channels: {
        "*": { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context);

    expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", {
      cfg,
      token: "xoxp-reader",
    });
    expect(readSlackMessages.mock.calls[0]?.[0]).toBe("C0123456789");
  });

  it("does not treat the core Channel provider value as a Slack room name", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("actual-room");

    cfg = namedPolicy({ channels: { "#slack": { enabled: true } } });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", { cfg });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not authorize different Slack targets with the current context channel ID", async () => {
    resolveSlackConversationName.mockResolvedValueOnce("other-channel");

    cfg = namedPolicy();

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C9876543210" }, cfg, {
        currentChannelId: "C0123456789",
      }),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).toHaveBeenCalledWith("C9876543210", { cfg });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not let a name match override an explicit channel-id denial", async () => {
    cfg = namedPolicy({
      groupPolicy: "open",
      channels: {
        C0123456789: { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationName).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed before reading when Slack cannot resolve the target name", async () => {
    resolveSlackConversationName.mockRejectedValueOnce(new Error("missing_scope"));
    cfg = namedPolicy();

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("missing_scope");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed for read-like Slack actions when provider config is missing", async () => {
    cfg = {};

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(readSlackMessages).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "reactions", channelId: "C1", messageId: "123.456" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(downloadSlackFile).not.toHaveBeenCalled();

    await expect(handleSlackAction({ action: "listPins", channelId: "C1" }, cfg)).rejects.toThrow(
      "Slack read target channel is not allowed.",
    );
    expect(listSlackPins).not.toHaveBeenCalled();
  });

  it("does not fall back to a bot token when a user identity has no user token", async () => {
    await expect(
      handleSlackAction(
        { action: "sendMessage", to: "channel:C1", content: "Hello" },
        slackConfig({ postAs: "user", botToken: "test-bot-token" }),
      ),
    ).rejects.toThrow('Slack operation token missing for account "default".');
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it("returns sorted usable emoji identifiers and preserves alias targets", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      cache_ts: "ignored-provider-metadata",
      emoji: {
        wave: "https://example.com/wave.png",
        celebrate: "alias:party",
        party: "https://example.com/party.png",
      },
    });

    const result = await handleSlackAction({ action: "emojiList", limit: 2 }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual([
      { name: "celebrate", identifier: "celebrate", aliasOf: "party" },
      { name: "party", identifier: "party" },
    ]);
  });
});
