import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedback = vi.hoisted(() => ({
  record: vi.fn(async () => true),
  reflect: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  recordChannelFeedbackEvent: feedback.record,
  runChannelFeedbackReflection: feedback.reflect,
}));

function createFeedbackInvokeContext({
  reaction = "like",
  senderId = "owner-aad",
  ...activity
}: Partial<MSTeamsTurnContext["activity"]> & {
  reaction?: "like" | "dislike";
  senderId?: string;
} = {}): MSTeamsTurnContext {
  return {
    activity: {
      type: "invoke",
      from: { id: `${senderId}-botframework`, aadObjectId: senderId, name: "Owner" },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
      },
      value: {
        actionName: "feedback",
        actionValue: {
          reaction,
          feedback: JSON.stringify({ feedbackText: "allowed feedback" }),
        },
        replyToId: "bot-msg-1",
      },
      ...activity,
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
  } as unknown as MSTeamsTurnContext;
}

function dmConfig(overrides: Partial<MSTeamsConfig> = {}): OpenClawConfig {
  return {
    channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["owner-aad"], ...overrides } },
  };
}

async function invoke(context: MSTeamsTurnContext, cfg: OpenClawConfig) {
  await runMSTeamsFeedbackInvokeHandler(context, createMSTeamsMessageHandlerDeps({ cfg }));
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    installMSTeamsTestRuntime();
    feedback.reflect.mockReset().mockResolvedValue({ status: "empty" });
    feedback.record.mockClear();
  });

  it("records DM feedback even when team route allowlists exist", async () => {
    await invoke(
      createFeedbackInvokeContext(),
      dmConfig({
        teams: {
          team123: { channels: { "19:group@thread.tacv2": { requireMention: false } } },
        },
      }),
    );
    expect(feedback.record).toHaveBeenCalledWith({
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
    await invoke(
      createFeedbackInvokeContext({
        conversation: { id: conversationId, conversationType: "channel" },
        replyToId,
      }),
      { channels: { msteams: { groupPolicy: "open" } } },
    );
    expect(feedback.record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "msteams:channel:19:channel@thread.tacv2:thread:root",
        event: expect.objectContaining({
          sessionKey: "msteams:channel:19:channel@thread.tacv2:thread:root",
        }),
      }),
    );
  });

  it.each([
    [
      "personal scope contradicts team metadata",
      { channelData: { team: { id: "unexpected-team", name: "Team 1" } } },
      dmConfig(),
    ],
    ["DM sender outside allowFrom", { senderId: "attacker-aad" }, dmConfig()],
    [
      "group sender outside groupAllowFrom",
      {
        reaction: "dislike",
        conversation: {
          id: "19:group@thread.tacv2;messageid=bot-msg-1",
          conversationType: "groupChat",
          tenantId: "tenant-1",
        },
        senderId: "attacker-aad",
        channelData: { team: { id: "team-1", name: "Team 1" }, channel: { name: "General" } },
      },
      dmConfig({
        groupPolicy: "allowlist",
        groupAllowFrom: ["owner-aad"],
        feedbackReflection: true,
      }),
    ],
  ] satisfies Array<[string, Parameters<typeof createFeedbackInvokeContext>[0], OpenClawConfig]>)(
    "blocks feedback and reflection: %s",
    async (_reason, context, cfg) => {
      await invoke(createFeedbackInvokeContext(context), cfg);
      expect(feedback.record).not.toHaveBeenCalled();
      expect(feedback.reflect).not.toHaveBeenCalled();
    },
  );
});
