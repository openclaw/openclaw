import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));
const channelInboundMockState = vi.hoisted(() => ({
  recordChannelFeedbackEvent: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  recordChannelFeedbackEvent: channelInboundMockState.recordChannelFeedbackEvent,
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return { ...actual, runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection };
});

function createDeps(cfg: OpenClawConfig): MSTeamsMessageHandlerDeps {
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
        }),
      },
    },
  } as unknown as PluginRuntime);
  return createMSTeamsMessageHandlerDeps({ cfg });
}

function createFeedbackInvokeContext(params: {
  reaction?: "like" | "dislike";
  conversationId?: string;
  conversationType?: string;
  senderId?: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  const { reaction = "like", senderId = "owner-aad" } = params;
  return {
    activity: {
      id: `invoke-${reaction}`,
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${senderId}-botframework`,
        aadObjectId: senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: params.conversationId ?? "a:personal-chat;messageid=bot-msg-1",
        conversationType: params.conversationType ?? "personal",
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      value: {
        actionName: "feedback",
        actionValue: {
          reaction,
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
  } as unknown as MSTeamsTurnContext;
}

function dmConfig(teams?: MSTeamsConfig["teams"]): OpenClawConfig {
  return { channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["owner-aad"], teams } } };
}

function expectFeedbackBlocked() {
  expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
  expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset().mockResolvedValue(undefined);
    channelInboundMockState.recordChannelFeedbackEvent.mockClear();
  });

  it("records DM feedback even when team route allowlists exist", async () => {
    await runMSTeamsFeedbackInvokeHandler(
      createFeedbackInvokeContext({ senderName: "Owner", comment: "allowed feedback" }),
      createDeps(
        dmConfig({
          team123: { channels: { "19:group@thread.tacv2": { requireMention: false } } },
        }),
      ),
    );
    expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "default",
      sessionKey: "msteams:direct:owner-aad",
      event: {
        type: "custom",
        event: "feedback",
        ts: expect.any(Number),
        messageId: "bot-msg-1",
        value: "positive",
        comment: "allowed feedback",
        sessionKey: "msteams:direct:owner-aad",
        agentId: "default",
        conversationId: "a:personal-chat",
      },
    });
  });

  it.each([
    ["19:channel@thread.tacv2;messageid=root", "nested"],
    ["19:channel@thread.tacv2", "root"],
  ])("records channel feedback in its message thread: %s", async (conversationId, replyToId) => {
    const context = createFeedbackInvokeContext({ conversationId, conversationType: "channel" });
    context.activity.replyToId = replyToId;
    await runMSTeamsFeedbackInvokeHandler(
      context,
      createDeps({ channels: { msteams: { groupPolicy: "open" } } }),
    );
    expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "msteams:channel:19:channel@thread.tacv2:thread:root",
        event: expect.objectContaining({
          sessionKey: "msteams:channel:19:channel@thread.tacv2:thread:root",
        }),
      }),
    );
  });

  it.each([
    {
      reason: "personal scope contradicts team metadata",
      cfg: dmConfig(),
      context: { teamId: "unexpected-team" },
    },
    {
      reason: "DM sender outside allowFrom",
      cfg: dmConfig(),
      context: { senderId: "attacker-aad" },
    },
    {
      reason: "group sender outside groupAllowFrom",
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
            feedbackReflection: true,
          },
        },
      },
      context: {
        reaction: "dislike",
        conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
        conversationType: "groupChat",
        senderId: "attacker-aad",
        teamId: "team-1",
        channelName: "General",
      },
    },
  ] satisfies Array<{
    reason: string;
    cfg: OpenClawConfig;
    context: Parameters<typeof createFeedbackInvokeContext>[0];
  }>)("blocks feedback and reflection: $reason", async ({ cfg, context }) => {
    await runMSTeamsFeedbackInvokeHandler(createFeedbackInvokeContext(context), createDeps(cfg));
    expectFeedbackBlocked();
  });
});
