import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { sendSlackMessage as sendSlackMessageThroughPublicOwner } from "./actions.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import type { SlackSendResult } from "./send.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const originalSlackActionRuntime = { ...slackActionRuntime };
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
    const accountConfig = params.cfg.channels?.slack as
      | { userToken?: string; botToken?: string; channels?: Record<string, unknown> }
      | undefined;
    const token = accountConfig?.userToken ?? accountConfig?.botToken;
    const tokenOverride = token && token !== accountConfig?.botToken ? { token } : {};
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

let cfg: OpenClawConfig;
const threadTs = "1111111111.111111";
const message = { channelId: "C123", messageId: "123.456" };
const send = { action: "sendMessage", to: "channel:C123" };
const upload = { action: "uploadFile", to: "channel:C123", filePath: "/tmp/report.png" };
function act(params: Record<string, unknown>, context?: SlackActionContext) {
  return handleSlackAction(params, cfg, context);
}
function sendText(
  content: string,
  params: Record<string, unknown> = {},
  context?: SlackActionContext,
) {
  return act({ ...send, ...params, content }, context);
}
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
  const result = await act({ action: "listPins", channelId: "C123" }, trustedContext);
  expect(listSlackPins).toHaveBeenCalledWith("C123", { cfg, teamId: "T123" });
  expect(result.details).toMatchObject({
    ok: true,
    pins: [{ message: { ts: "1712345678.123456", text: "pin", timestampMs: 1712345678123 } }],
  });
});

it("rejects a bare detached target for an authenticated Enterprise install", async () => {
  const installationState = registerSlackInstallationState("default", "enterprise");
  try {
    await expect(act({ action: "react", ...message, emoji: "thumbsup" })).rejects.toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    expect(reactSlackMessage).not.toHaveBeenCalled();
  } finally {
    installationState.release();
  }
});

it("reads the current requester from the trusted current workspace", async () => {
  const info = { ok: true, user: { id: "U123", is_bot: false } };
  getSlackMemberInfo.mockResolvedValueOnce(info);
  const result = await act(
    { action: "memberInfo", userId: "U123" },
    {
      ...trustedContext,
      requesterSenderId: "U123",
    },
  );
  expect(getSlackMemberInfo).toHaveBeenCalledWith("U123", { cfg, teamId: "T123" });
  expect(result.details).toEqual({ ok: true, info });
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
        act(
          { action, userId: "U123" },
          {
            ...context,
            currentChannelProvider: "slack",
            requesterAccountId: "default",
            requesterSenderId: "U123",
          },
        ),
      ).rejects.toThrow("unsupported_enterprise_slack_delivery");
    }
    expect(getSlackMemberInfo).not.toHaveBeenCalled();
    expect(listSlackEmojis).not.toHaveBeenCalled();
  } finally {
    installationState.release();
  }
});

it("scopes every message and pin write to the trusted current workspace", async () => {
  await sendText("created", {}, trustedContext);
  await act({ action: "editMessage", ...message, content: "updated" }, trustedContext);
  for (const action of ["deleteMessage", "pinMessage", "unpinMessage"]) {
    await act({ action, ...message }, trustedContext);
  }
  expectSend(
    0,
    "created",
    { mediaUrl: undefined, threadTs: undefined, blocks: undefined },
    "team:T123:channel:C123",
  );
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
  const history = await act(
    {
      action: "readMessages",
      channelId: "C123",
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
      limit: "20",
    },
    trustedContext,
  );
  await act({ action: "reactions", ...message }, trustedContext);
  await act({ action: "downloadFile", channelId: "C123", fileId: "F123" }, trustedContext);
  await act({ action: "emojiList" }, trustedContext);
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
    currentThreadTs: threadTs,
    replyToMode: "first",
    hasRepliedRef,
  };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectSend(
  index: number,
  content: string,
  optionFields: Record<string, unknown>,
  target = "channel:C123",
) {
  const call = sendSlackMessage.mock.calls[index];
  expect(call).toEqual([target, content, expect.objectContaining({ cfg, ...optionFields })]);
  return requireRecord(call?.[2], "Slack send options");
}

function expectLastSlackSend(content: string, config: OpenClawConfig, expectedThread?: string) {
  expectSend(sendSlackMessage.mock.calls.length - 1, content, {
    cfg: config,
    mediaUrl: undefined,
    threadTs: expectedThread,
    blocks: undefined,
  });
}

function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
  return requireRecord(result.details, "action result details");
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
  await sendText(
    "root",
    { topLevel: true },
    {
      currentChannelId: "C123",
      replyToMode: "all",
      sameChannelThreadRequired: true,
    },
  );
  expectLastSlackSend("root", cfg);
});

it("forwards preformatted fallback text and trusted forced-media access for user identity", async () => {
  cfg = slackConfig({ postAs: "user", userToken: "test-user-token" });
  const mediaAccess = {
    localRoots: ["/tmp/workspace-agent"],
    readFile: vi.fn(async () => Buffer.from("image")),
    workspaceDir: "/tmp/workspace-agent",
  };
  await sendText(
    "- Account: &lt;@U123&gt;",
    { mediaUrl: "https://example.com/report.csv", textIsSlackMrkdwn: true, forceDocument: true },
    { mediaAccess, mediaLocalRoots: mediaAccess.localRoots },
  );
  const options = expectSend(0, "- Account: &lt;@U123&gt;", {
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
    const result = await act(
      { action: "react", channelId: "channel:c08gqh53ejm", messageId: "123.456", emoji: "✅" },
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
  await act(
    { action: "react", ...message, emoji: "✅" },
    {
      ...trustedContext,
      ...patch,
    },
  );
  expect(reactSlackMessage).toHaveBeenCalledWith("C123", "123.456", "✅", { cfg });
});

it.each([
  {
    name: "an explicit reaction in its workspace",
    channelId: "team:T123:channel:C123",
    emoji: "✅",
    remove: true,
  },
  { name: "own reactions on empty emoji", channelId: "C1", emoji: "", remove: undefined },
])("removes $name", async ({ channelId, emoji, remove }) => {
  await act({ action: "react", channelId, messageId: "123.456", emoji, remove });
  if (remove) {
    expect(removeSlackReaction).toHaveBeenCalledWith("C123", "123.456", "✅", {
      cfg,
      teamId: "T123",
    });
  } else {
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456", { cfg });
  }
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
  const result = await act(
    { action: "downloadFile", fileId: "F123" },
    {
      currentChannelId: "C_ALLOWED",
    },
  );
  expect(downloadSlackFile).toHaveBeenCalledWith(
    "F123",
    expect.objectContaining({
      channelId: "C_ALLOWED",
      cfg,
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

it.each([
  { params: send, error: /requires content, blocks, or mediaUrl/i },
  { params: { action: "editMessage", ...message }, error: /requires content or blocks/i },
])("requires a payload for $params.action", async ({ params, error }) => {
  await expect(act({ ...params, content: "" })).rejects.toThrow(error);
});

it("uploads metadata and original media through the trusted workspace using a writable user token", async () => {
  const defaultAccount = { userToken: "xoxp-user", userTokenReadOnly: false };
  cfg = { channels: { slack: { accounts: { default: defaultAccount } } } };
  await act(
    {
      ...upload,
      initialComment: "fresh report",
      filename: "report-final.png",
      title: "Report Final",
      threadTs: "111.222",
      forceDocument: true,
    },
    trustedContext,
  );
  expectSend(
    0,
    "fresh report",
    {
      token: "xoxp-user",
      mediaUrl: "/tmp/report.png",
      threadTs: "111.222",
      uploadFileName: "report-final.png",
      uploadTitle: "Report Final",
      forceDocument: true,
    },
    "team:T123:channel:C123",
  );
});

it("rejects replyBroadcast for uploadFile", async () => {
  await expect(
    handleSlackAction({ ...upload, threadTs: "111.222", replyBroadcast: true }, slackConfig()),
  ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
});

it.each([false, true])("sends media before separate blocks (prepared=%s)", async (prepared) => {
  sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "F123" });
  sendSlackMessage.mockResolvedValueOnce({ channelId: "C123", messageId: "123.456" });

  const result = await sendText(
    "",
    { mediaUrl: "https://example.com/file.png", blocks: JSON.stringify([{ type: "divider" }]) },
    prepared ? { preparedMessages: [{ text: "", blocks: [{ type: "divider" }] }] } : undefined,
  );

  expect(sendSlackMessage).toHaveBeenCalledTimes(2);
  expectSend(0, "", { mediaUrl: "https://example.com/file.png", threadTs: undefined });
  expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
    "blocks",
  );
  expectSend(1, "", { blocks: [{ type: "divider" }], threadTs: undefined });
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

  const result = await sendText(content, { blocks, replyBroadcast: true }, context);

  expect(sendSlackMessage).toHaveBeenCalledTimes(2);
  expectSend(0, "", { blocks, threadTs });
  expect(requireRecord(sendSlackMessage.mock.calls[0]?.[2], "send options")).not.toHaveProperty(
    "replyBroadcast",
  );
  const textOptions = expectSend(1, content, { replyBroadcast: true, threadTs });
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

  await sendText(content, { blocks, nativeDataFallbackBaseText: "Pipeline summary" });

  expect(sendSlackMessage).toHaveBeenCalledOnce();
  expectSend(0, content, {
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
          threadId: threadTs,
        })),
        threadId: threadTs,
        sentAt: 123,
      },
    });
  }

  const result = await sendText(
    "",
    { blocks: chartBlocks, replyBroadcast: true },
    {
      ...createReplyToFirstContext(hasRepliedRef),
      preparedMessages: [
        { text: "Revenue", blocks: chartBlocks, authoredTextPlacement: "blocks" },
        { text: "Wide table fallback", textIsSlackPlainText: true },
      ],
    },
  );

  expect(sendSlackMessage).toHaveBeenCalledTimes(2);
  expectSend(0, "Revenue", {
    blocks: chartBlocks,
    authoredTextPlacement: "blocks",
    replyBroadcast: true,
    threadTs,
  });
  expectSend(1, "Wide table fallback", { textIsSlackPlainText: true, threadTs });
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
        threadId: threadTs,
        sentAt: 123,
      },
    },
  });
});

it("edits blocks without requiring text", async () => {
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "updated" } }];
  await act({ action: "editMessage", ...message, blocks });
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
  await expect(act(params, context)).rejects.toThrow("Slack transport failed");
  expect(context.hasRepliedRef.value).toBe(false);
  await act(params, context);
  for (const index of [0, 1]) {
    expectSend(index, "First", { threadTs });
  }
  expect(context.hasRepliedRef.value).toBe(true);
  await sendText("Second", {}, context);
  expectLastSlackSend("Second", cfg);
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

  await expect(sendText("a".repeat(8500), {}, context)).rejects.toThrow(
    "Second Slack text chunk failed",
  );

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
  const firstAttempt = sendText("Pending", {}, context);
  await started.promise;
  expect(sendSlackMessage).toHaveBeenCalledOnce();
  await sendText("Accepted", {}, context);
  expectSend(1, "Accepted", { threadTs });
  expect(context.hasRepliedRef.value).toBe(true);
  firstDelivery.reject(new Error("First Slack delivery failed"));
  await expect(firstAttempt).rejects.toThrow("First Slack delivery failed");
  expect(context.hasRepliedRef.value).toBe(true);
});

it.each([
  {
    name: "a prepared channel override disables auto-threading",
    to: "channel:C123",
    context: () =>
      buildSlackThreadingToolContext({
        cfg: slackConfig({ replyToMode: "all", channels: { C123: { replyToMode: "off" } } }),
        context: {
          ChatType: "channel",
          To: "channel:C123",
          CurrentMessageId: threadTs,
          ReplyToId: threadTs,
          ReplyToMode: "off",
        },
      }),
  },
  {
    name: "replyToMode=first has no hasRepliedRef",
    to: "#c123",
    context: (): SlackActionContext => ({
      currentChannelId: "C123",
      currentThreadTs: threadTs,
      replyToMode: "first",
    }),
  },
])("does not thread when $name", async ({ to, context }) => {
  await sendText("Channel root", { to }, context());
  expectSend(
    0,
    "Channel root",
    { mediaUrl: undefined, threadTs: undefined, blocks: undefined },
    to,
  );
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

  await act({ action: "readMessages", channelId: "C0123456789" }, context);

  expect(resolveSlackConversationName).toHaveBeenCalledWith("C0123456789", {
    cfg,
    token: "xoxp-reader",
  });
  expect(readSlackMessages.mock.calls[0]?.[0]).toBe("C0123456789");
});

it.each([
  {
    name: "the core Channel provider is not a room name",
    channelId: "C0123456789",
    overrides: { channels: { "#slack": { enabled: true } } },
    coreContext: true,
    lookup: "actual-room",
  },
  {
    name: "the current channel cannot authorize a different target",
    channelId: "C9876543210",
    context: { currentChannelId: "C0123456789" },
    lookup: "other-channel",
  },
  {
    name: "an explicit channel-id denial outranks a name match",
    channelId: "C0123456789",
    overrides: {
      groupPolicy: "open",
      channels: { C0123456789: { enabled: false }, "#allowed-channel": { enabled: true } },
    },
  },
  {
    name: "a failed name lookup cannot authorize a read",
    channelId: "C0123456789",
    lookup: new Error("missing_scope"),
  },
])("fails closed when $name", async ({ channelId, overrides, coreContext, context, lookup }) => {
  cfg = namedPolicy(overrides);
  if (lookup instanceof Error) {
    resolveSlackConversationName.mockRejectedValueOnce(lookup);
  } else if (lookup) {
    resolveSlackConversationName.mockResolvedValueOnce(lookup);
  }
  const readContext = coreContext
    ? buildSlackThreadingToolContext({
        cfg,
        accountId: null,
        context: { ChatType: "channel", Channel: "slack", To: "channel:C0123456789" },
      })
    : context;
  await expect(act({ action: "readMessages", channelId }, readContext)).rejects.toThrow(
    lookup instanceof Error ? "missing_scope" : "Slack read target channel is not allowed.",
  );
  if (lookup !== undefined) {
    expect(resolveSlackConversationName).toHaveBeenCalledWith(channelId, { cfg });
  } else {
    expect(resolveSlackConversationName).not.toHaveBeenCalled();
  }
  expect(readSlackMessages).not.toHaveBeenCalled();
});

it("fails closed for read-like Slack actions when provider config is missing", async () => {
  cfg = {};
  for (const [params, operation] of [
    [{ action: "readMessages" }, readSlackMessages],
    [{ action: "reactions", messageId: "123.456" }, listSlackReactions],
    [{ action: "downloadFile", fileId: "F123" }, downloadSlackFile],
    [{ action: "listPins" }, listSlackPins],
  ] as const) {
    await expect(act({ ...params, channelId: "C1" })).rejects.toThrow(
      "Slack read target channel is not allowed.",
    );
    expect(operation).not.toHaveBeenCalled();
  }
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
