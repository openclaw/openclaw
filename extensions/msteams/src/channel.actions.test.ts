import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getMessageMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  unpinMessageMSTeamsMock,
} = vi.hoisted(() => ({
  editMessageMSTeamsMock: vi.fn(),
  deleteMessageMSTeamsMock: vi.fn(),
  getMessageMSTeamsMock: vi.fn(),
  listReactionsMSTeamsMock: vi.fn(),
  pinMessageMSTeamsMock: vi.fn(),
  reactMessageMSTeamsMock: vi.fn(),
  searchMessagesMSTeamsMock: vi.fn(),
  sendAdaptiveCardMSTeamsMock: vi.fn(),
  unpinMessageMSTeamsMock: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    editMessageMSTeams: editMessageMSTeamsMock,
    deleteMessageMSTeams: deleteMessageMSTeamsMock,
    getMessageMSTeams: getMessageMSTeamsMock,
    listReactionsMSTeams: listReactionsMSTeamsMock,
    pinMessageMSTeams: pinMessageMSTeamsMock,
    reactMessageMSTeams: reactMessageMSTeamsMock,
    searchMessagesMSTeams: searchMessagesMSTeamsMock,
    sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsMock,
    unpinMessageMSTeams: unpinMessageMSTeamsMock,
  },
}));

import { msteamsPlugin } from "./channel.js";

const actionMocks = [
  editMessageMSTeamsMock,
  deleteMessageMSTeamsMock,
  getMessageMSTeamsMock,
  listReactionsMSTeamsMock,
  pinMessageMSTeamsMock,
  reactMessageMSTeamsMock,
  searchMessagesMSTeamsMock,
  sendAdaptiveCardMSTeamsMock,
  unpinMessageMSTeamsMock,
];
const currentChannelId = "conversation:19:ctx@thread.tacv2";
const reactChannelId = "conversation:19:react@thread.tacv2";
const targetChannelId = "conversation:19:target@thread.tacv2";
const editedConversationId = "19:edited@thread.tacv2";
const editedMessageId = "msg-edit-1";
const readMessage = { id: "msg-1", text: "hello" };
const reactionType = "like";
const updatedText = "updated text";
const reactionTypes = ["like", "heart", "laugh", "surprised", "sad", "angry"];
const deleteMissingTargetError = "Delete requires a target (to) and messageId.";
const reactionsMissingTargetError = "Reactions requires a target (to) and messageId.";
const cardSendMissingTargetError = "Card send requires a target (to).";
const reactMissingEmojiError =
  "React requires an emoji (reaction type). Valid types: like, heart, laugh, surprised, sad, angry.";
const reactMissingEmojiDetail = "React requires an emoji (reaction type).";
const searchMissingQueryError = "Search requires a target (to) and query.";

function padded(value: string) {
  return ` ${value} `;
}

function msteamsActionDetails(action: string, details?: Record<string, unknown>) {
  return {
    channel: "msteams",
    action,
    ...details,
  };
}

function okMSTeamsActionDetails(action: string, details?: Record<string, unknown>) {
  return msteamsActionDetails(action, { ok: true, ...details });
}

function requireMSTeamsHandleAction() {
  const handleAction = msteamsPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("msteams actions.handleAction unavailable");
  }
  return handleAction;
}

async function runAction(params: {
  action: string;
  cfg?: Record<string, unknown>;
  params?: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  const handleAction = requireMSTeamsHandleAction();
  return await handleAction({
    channel: "msteams",
    action: params.action,
    cfg: params.cfg ?? {},
    params: params.params ?? {},
    toolContext: params.toolContext,
  } as any);
}

async function expectActionError(
  params: Parameters<typeof runAction>[0],
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expect(runAction(params)).resolves.toEqual({
    isError: true,
    content: [{ type: "text", text: expectedMessage }],
    details: expectedDetails ?? { error: expectedMessage },
  });
}

async function expectActionParamError(
  action: Parameters<typeof runAction>[0]["action"],
  params: Record<string, unknown>,
  expectedMessage: string,
  expectedDetails?: Record<string, unknown>,
) {
  await expectActionError({ action, params }, expectedMessage, expectedDetails);
}

function expectActionSuccess(
  result: Awaited<ReturnType<typeof runAction>>,
  details: Record<string, unknown>,
  contentDetails: Record<string, unknown> = details,
) {
  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify(contentDetails),
      },
    ],
    details,
  });
}

function expectActionRuntimeCall(
  mockFn: ReturnType<typeof vi.fn>,
  params: Record<string, unknown>,
) {
  expect(mockFn).toHaveBeenCalledWith({
    cfg: {},
    ...params,
  });
}

async function expectSuccessfulAction(params: {
  mockFn: ReturnType<typeof vi.fn>;
  mockResult: unknown;
  action: Parameters<typeof runAction>[0]["action"];
  actionParams?: Parameters<typeof runAction>[0]["params"];
  toolContext?: Parameters<typeof runAction>[0]["toolContext"];
  runtimeParams: Record<string, unknown>;
  details: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
}) {
  params.mockFn.mockResolvedValue(params.mockResult);
  const result = await runAction({
    action: params.action,
    params: params.actionParams,
    toolContext: params.toolContext,
  });
  expectActionRuntimeCall(params.mockFn, params.runtimeParams);
  expectActionSuccess(result, params.details, params.contentDetails);
}

describe("msteamsPlugin message actions", () => {
  beforeEach(() => {
    for (const mockFn of actionMocks) {
      mockFn.mockReset();
    }
  });

  it("falls back to toolContext.currentChannelId for read actions", async () => {
    await expectSuccessfulAction({
      mockFn: getMessageMSTeamsMock,
      mockResult: readMessage,
      action: "read",
      actionParams: {
        messageId: padded("msg-1"),
      },
      toolContext: {
        currentChannelId: padded(currentChannelId),
      },
      runtimeParams: {
        to: currentChannelId,
        messageId: "msg-1",
      },
      details: okMSTeamsActionDetails("read", {
        message: readMessage,
      }),
      contentDetails: {
        ok: true,
        channel: "msteams",
        action: "read",
        message: readMessage,
      },
    });
  });

  it("accepts target as an alias for pin actions", async () => {
    await expectSuccessfulAction({
      mockFn: pinMessageMSTeamsMock,
      mockResult: { ok: true, pinnedMessageId: "pin-1" },
      action: "pin",
      actionParams: {
        target: padded(targetChannelId),
        messageId: padded("msg-2"),
      },
      runtimeParams: {
        to: targetChannelId,
        messageId: "msg-2",
      },
      details: okMSTeamsActionDetails("pin", {
        pinnedMessageId: "pin-1",
      }),
    });
  });

  it("falls back from content to message fields for edit actions", async () => {
    await expectSuccessfulAction({
      mockFn: editMessageMSTeamsMock,
      mockResult: { conversationId: editedConversationId },
      action: "edit",
      actionParams: {
        to: targetChannelId,
        messageId: editedMessageId,
        content: updatedText,
      },
      runtimeParams: {
        to: targetChannelId,
        activityId: editedMessageId,
        text: updatedText,
      },
      details: {
        ok: true,
        channel: "msteams",
      },
      contentDetails: {
        ok: true,
        channel: "msteams",
        conversationId: editedConversationId,
      },
    });
  });

  it("falls back from pinnedMessageId to messageId for unpin actions", async () => {
    await expectSuccessfulAction({
      mockFn: unpinMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "unpin",
      actionParams: {
        target: padded(targetChannelId),
        messageId: padded("pin-2"),
      },
      runtimeParams: {
        to: targetChannelId,
        pinnedMessageId: "pin-2",
      },
      details: okMSTeamsActionDetails("unpin"),
    });
  });

  it("reuses currentChannelId fallback for react actions", async () => {
    await expectSuccessfulAction({
      mockFn: reactMessageMSTeamsMock,
      mockResult: { ok: true },
      action: "react",
      actionParams: {
        messageId: padded("msg-3"),
        emoji: padded(reactionType),
      },
      toolContext: {
        currentChannelId: padded(reactChannelId),
      },
      runtimeParams: {
        to: reactChannelId,
        messageId: "msg-3",
        reactionType,
      },
      details: okMSTeamsActionDetails("react", {
        reactionType,
      }),
      contentDetails: {
        channel: "msteams",
        action: "react",
        reactionType,
        ok: true,
      },
    });
  });

  it("shares the missing target and messageId validation across actions", async () => {
    await expectActionParamError("delete", {}, deleteMissingTargetError);

    await expectActionParamError("reactions", { to: targetChannelId }, reactionsMissingTargetError);
  });

  it("keeps card-send target validation shared", async () => {
    await expectActionParamError(
      "send",
      { card: { type: "AdaptiveCard" } },
      cardSendMissingTargetError,
    );
  });

  it("reports the allowed reaction types when emoji is missing", async () => {
    await expectActionParamError(
      "react",
      {
        to: targetChannelId,
        messageId: "msg-4",
      },
      reactMissingEmojiError,
      {
        error: reactMissingEmojiDetail,
        validTypes: reactionTypes,
      },
    );
  });

  it("requires a non-empty search query after trimming", async () => {
    await expectActionParamError(
      "search",
      {
        to: targetChannelId,
        query: "   ",
      },
      searchMissingQueryError,
    );
  });
});
