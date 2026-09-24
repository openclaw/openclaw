// Conversation allowlists authorize group threads without widening sender or DM access.
import { listSessionEntries } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps } from "./message-handler.test-support.js";

type HandlerInput = Parameters<ReturnType<typeof createMSTeamsMessageHandler>>[0];
type ConversationType = "personal" | "groupChat" | "channel";
type ConversationCase = {
  label: string;
  conversationId: string;
  conversationType: ConversationType;
  senderName?: string;
  dangerouslyAllowNameMatching?: boolean;
};

const runtimeApiMockState = getRuntimeApiMockState();

vi.mock("../graph-thread.js", () => ({
  fetchChannelMessage: vi.fn(async () => undefined),
  fetchThreadReplies: vi.fn(async () => []),
  fetchChatMessageText: vi.fn(async () => undefined),
  buildThreadContext: vi.fn(() => []),
  stripHtmlFromTeamsMessage: vi.fn((value: string) => value),
}));

vi.mock("../team-identity.js", () => ({
  resolveTeamGroupId: vi.fn(async () => "group-1"),
}));

function createDeps(cfg: OpenClawConfig) {
  return createMessageHandlerDeps(cfg, {
    readAllowFromStore: vi.fn(async () => ["attacker-aad"]),
    upsertPairingRequest: vi.fn(async () => null),
  });
}

function createMessageActivity(params: {
  id: string;
  text: string;
  conversation: { id: string; conversationType: ConversationType };
  from: { id: string; aadObjectId: string; name: string };
  channelData?: Record<string, unknown>;
}): HandlerInput {
  return {
    activity: {
      id: params.id,
      type: "message",
      text: params.text,
      from: params.from,
      recipient: { id: "bot-id", name: "Bot" },
      conversation: params.conversation,
      channelData: params.channelData ?? {},
      attachments: [],
    },
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  } satisfies HandlerInput;
}

describe("msteams group conversation allowlist authorization", () => {
  it.each([
    {
      label: "a group chat",
      allowEntry: "19:group@thread.tacv2",
      conversationId: "19:group@thread.tacv2",
      conversationType: "groupChat" as const,
    },
    {
      label: "a channel",
      allowEntry: "19:channel@thread.tacv2",
      conversationId: "19:channel@thread.tacv2",
      conversationType: "channel" as const,
    },
    {
      label: "a message-suffixed conversation",
      allowEntry: "19:group@thread.tacv2",
      conversationId: "19:group@thread.tacv2;messageid=1740123456789",
      conversationType: "groupChat" as const,
    },
    {
      label: "a message-suffixed allowlist entry",
      allowEntry: "19:group@thread.tacv2;messageid=1740123456789",
      conversationId: "19:group@thread.tacv2",
      conversationType: "groupChat" as const,
    },
    {
      label: "a legacy Skype thread",
      allowEntry: "19:legacy@thread.skype",
      conversationId: "19:legacy@thread.skype",
      conversationType: "groupChat" as const,
    },
    {
      label: "a standard v2 group-chat thread",
      allowEntry: "19:modern-group@thread.v2",
      conversationId: "19:modern-group@thread.v2;messageid=1740123456789",
      conversationType: "groupChat" as const,
    },
    {
      label: "an exactly matched mixed-case opaque conversation",
      allowEntry: "19:MiXeD-group@thread.tacv2",
      conversationId: "19:MiXeD-group@thread.tacv2",
      conversationType: "groupChat" as const,
    },
  ])("authorizes $label by its group conversation allowlist", async (testCase) => {
    runtimeApiMockState.dispatchReplyFromConfig.mockClear();
    const { conversationStore, deps } = createDeps({
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          groupAllowFrom: [testCase.allowEntry],
          requireMention: false,
        },
      },
    } as OpenClawConfig);

    await createMSTeamsMessageHandler(deps)(
      createMessageActivity({
        id: "conversation-allowlist-message",
        text: "hello from the allowed conversation",
        from: {
          id: "group-member-bot-framework-id",
          aadObjectId: "group-member-aad",
          name: "Group Member",
        },
        conversation: {
          id: testCase.conversationId,
          conversationType: testCase.conversationType,
        },
      }),
    );

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtimeApiMockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("authorizes a group conversation from the documented direct allowlist fallback", async () => {
    runtimeApiMockState.dispatchReplyFromConfig.mockClear();
    const { conversationStore, deps } = createDeps({
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          allowFrom: ["19:fallback-group@thread.v2"],
          requireMention: false,
        },
      },
    } as OpenClawConfig);

    await createMSTeamsMessageHandler(deps)(
      createMessageActivity({
        id: "fallback-conversation-allowlist-message",
        text: "hello from the fallback group",
        from: {
          id: "fallback-member-bot-framework-id",
          aadObjectId: "fallback-member-aad",
          name: "Fallback Member",
        },
        conversation: {
          id: "19:fallback-group@thread.v2",
          conversationType: "groupChat",
        },
      }),
    );

    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(runtimeApiMockState.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  const rejectedCases: ConversationCase[] = [
    {
      label: "another group conversation",
      conversationId: "19:another-group@thread.tacv2",
      conversationType: "groupChat",
    },
    {
      label: "a distinct group differing only in opaque ID case",
      conversationId: "19:GROUP@thread.tacv2",
      conversationType: "groupChat",
    },
    {
      label: "a personal conversation with the allowlisted group ID",
      conversationId: "19:group@thread.tacv2",
      conversationType: "personal",
    },
    {
      label: "a sender spoofing the allowlisted conversation as a display name",
      conversationId: "19:another-group@thread.tacv2",
      conversationType: "groupChat",
      senderName: "19:group@thread.tacv2",
      dangerouslyAllowNameMatching: true,
    },
  ];

  it.each(rejectedCases)(
    "does not authorize $label by a group conversation allowlist",
    async (testCase) => {
      runtimeApiMockState.dispatchReplyFromConfig.mockClear();
      const { conversationStore, deps, resolveStorePath } = createDeps({
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["19:group@thread.tacv2"],
            groupPolicy: "allowlist",
            groupAllowFrom: ["19:group@thread.tacv2"],
            requireMention: false,
            dangerouslyAllowNameMatching: testCase.dangerouslyAllowNameMatching ?? false,
          },
        },
      } as OpenClawConfig);

      await createMSTeamsMessageHandler(deps)(
        createMessageActivity({
          id: "blocked-conversation-allowlist-message",
          text: "hello from the wrong conversation",
          from: {
            id: "unlisted-member-bot-framework-id",
            aadObjectId: "unlisted-member-aad",
            name: testCase.senderName ?? "Unlisted Member",
          },
          conversation: {
            id: testCase.conversationId,
            conversationType: testCase.conversationType,
          },
        }),
      );

      expect(conversationStore.upsert).not.toHaveBeenCalled();
      expect(runtimeApiMockState.dispatchReplyFromConfig).not.toHaveBeenCalled();
      expect(
        listSessionEntries({ agentId: "main", storePath: resolveStorePath(), readOnly: true }),
      ).toEqual([]);
    },
  );

  it("drops a personal message with contradictory team scope before routing", async () => {
    runtimeApiMockState.dispatchReplyFromConfig.mockClear();
    const { conversationStore, deps, enqueueSystemEvent, resolveAgentRoute } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["sender-aad"],
        },
      },
    } as OpenClawConfig);

    await createMSTeamsMessageHandler(deps)(
      createMessageActivity({
        id: "msg-conflicting-scope",
        text: "hello",
        from: { id: "sender-id", aadObjectId: "sender-aad", name: "Sender" },
        conversation: { id: "a:personal-chat", conversationType: "personal" },
        channelData: { team: { id: "unexpected-team" } },
      }),
    );

    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});
