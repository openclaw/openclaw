import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import type { ClickClackInboundAccess } from "./access.js";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig } from "./types.js";

const sendClickClackInboundReplyMock = vi.hoisted(() => vi.fn());
const SOURCE_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5fav";
const CONFIG = {
  channels: {
    clickclack: {
      baseUrl: "http://127.0.0.1:8080",
      token: "test-token-placeholder",
      workspace: "wsp_1",
    },
  },
} as CoreConfig;

vi.mock("./outbound.js", () => ({
  sendClickClackInboundReply: sendClickClackInboundReplyMock,
}));

function createMessage(overrides: Partial<ClickClackMessage> = {}): ClickClackMessage {
  return {
    id: SOURCE_MESSAGE_ID,
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_owner",
    thread_root_id: SOURCE_MESSAGE_ID,
    body: "replay proof",
    body_format: "markdown",
    created_at: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function createAccess(params: {
  isDirect: boolean;
  target: string;
}): ClickClackInboundAccess {
  return {
    shouldDispatch: true,
    commandAuthorized: true,
    mentionFacts: { canDetectMention: true, wasMentioned: true },
    preparedRoute: {
      isDirect: params.isDirect,
      target: params.target,
      route: {
        agentId: "main",
        channel: "clickclack",
        accountId: "default",
        dmScope: "main",
        sessionKey: `agent:main:clickclack:${params.target}`,
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      revoked: false,
    },
  };
}

describe("ClickClack inbound replay ordinals", () => {
  beforeEach(() => {
    sendClickClackInboundReplyMock.mockReset();
  });

  it.each([
    {
      name: "channel",
      message: createMessage(),
      access: createAccess({ isDirect: false, target: "channel:chn_1" }),
      to: "channel:chn_1",
      threadId: undefined,
    },
    {
      name: "thread",
      message: createMessage({
        parent_message_id: "msg_parent",
        thread_root_id: "msg_thread_root",
      }),
      access: createAccess({ isDirect: false, target: "channel:chn_1" }),
      to: "channel:chn_1",
      threadId: "msg_thread_root",
    },
    {
      name: "direct message",
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dm_1",
      }),
      access: createAccess({ isDirect: true, target: "dm:usr_owner" }),
      to: "dm:usr_owner",
      threadId: undefined,
    },
  ])("reuses stable agent reply ordinals after $name replay", async ({
    access,
    message,
    threadId,
    to,
  }) => {
    const runtime = createPluginRuntimeMock();
    setClickClackRuntime(runtime);
    const account = resolveClickClackAccount({ cfg: CONFIG });

    const dispatchOnce = async () => {
      await handleClickClackInbound({ account, config: CONFIG, message, access });
      const calls = vi.mocked(runtime.channel.inbound.dispatch).mock.calls;
      return calls.at(-1)?.[0].delivery;
    };

    const firstDelivery = await dispatchOnce();
    await firstDelivery?.deliver({ text: "first part" }, { kind: "block" });
    await firstDelivery?.deliver({ text: "final part" }, { kind: "final" });
    const replayDelivery = await dispatchOnce();
    await replayDelivery?.deliver({ text: "regenerated first part" }, { kind: "block" });

    expect(sendClickClackInboundReplyMock.mock.calls.map(([call]) => call.deliveryPartIndex)).toEqual(
      [0, 1, 0],
    );
    expect(sendClickClackInboundReplyMock).toHaveBeenCalledTimes(3);
    for (const [call] of sendClickClackInboundReplyMock.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          replyToId: SOURCE_MESSAGE_ID,
          sourceMessageId: SOURCE_MESSAGE_ID,
          threadId,
          to,
        }),
      );
    }
  });
});
