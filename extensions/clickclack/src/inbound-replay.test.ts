import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
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

function createAccess(params: { isDirect: boolean; target: string }): ClickClackInboundAccess {
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

describe("ClickClack atomic inbound reply replay", () => {
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
  ])(
    "keeps one source-stable reply across changed $name replay boundaries",
    async ({ access, message, threadId, to }) => {
      const runtime = createPluginRuntimeMock();
      let dispatchAttempt = 0;
      runtime.channel.inbound.dispatch = vi.fn(
        async (plan: Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0]) => {
          if (dispatchAttempt++ === 0) {
            await plan.delivery.deliver({ text: "first part" }, { kind: "block" });
            await plan.delivery.deliver({ text: "final part" }, { kind: "final" });
          } else {
            await plan.delivery.deliver({ text: "regenerated combined output" }, { kind: "final" });
          }
          return {
            admission: { kind: "dispatch" },
            dispatched: true,
            ctxPayload: plan.ctxPayload,
            routeSessionKey: plan.route.sessionKey,
            dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 1, final: 1 } },
          };
        },
      ) as unknown as PluginRuntime["channel"]["inbound"]["dispatch"];
      setClickClackRuntime(runtime);
      const account = resolveClickClackAccount({ cfg: CONFIG });

      await handleClickClackInbound({ account, config: CONFIG, message, access });
      await handleClickClackInbound({ account, config: CONFIG, message, access });

      expect(sendClickClackInboundReplyMock).toHaveBeenCalledTimes(2);
      expect(sendClickClackInboundReplyMock.mock.calls.map(([call]) => call.text)).toEqual([
        "first part\n\nfinal part",
        "regenerated combined output",
      ]);
      for (const [call] of sendClickClackInboundReplyMock.mock.calls) {
        expect(call).toEqual(
          expect.objectContaining({
            replyToId: SOURCE_MESSAGE_ID,
            sourceMessageId: SOURCE_MESSAGE_ID,
            threadId,
            to,
          }),
        );
        expect(call).not.toHaveProperty("deliveryPartIndex");
      }
    },
  );
});
