import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

vi.mock("../team-identity.js", () => ({
  resolveTeamGroupId: vi.fn(async () => undefined),
}));

const { dispatchReplyWithBufferedBlockDispatcher } = getRuntimeApiMockState();
const channelSessionKey = `agent:main:msteams:channel:${channelConversationId}`;

describe("msteams channel session policy through inbound dispatch", () => {
  beforeEach(() => {
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("applies global policy changes without replacing the handler", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open", threadSessionPolicy: "channel" } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);
    for (const [index, policy] of (["channel", "thread", "channel"] as const).entries()) {
      const current: OpenClawConfig = {
        channels: { msteams: { groupPolicy: "open", threadSessionPolicy: policy } },
      };
      setRuntimeConfigSnapshot(current, current);
      await handler({
        activity: buildChannelActivity({
          id: `policy-reply-${index}`,
          replyToId: "original-root",
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(index + 1);
      expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[index]?.[0].ctx).toMatchObject({
        SessionKey:
          policy === "channel" ? channelSessionKey : `${channelSessionKey}:thread:original-root`,
        MessageThreadId: "original-root",
      });
    }
  });

  it.each<{
    name: string;
    config: MSTeamsConfig;
    shared: boolean;
  }>([
    { name: "default thread isolation", config: {}, shared: false },
    { name: "global channel opt-in", config: { threadSessionPolicy: "channel" }, shared: true },
    {
      name: "team-only channel opt-in",
      config: { teams: { "team-1": { threadSessionPolicy: "channel" } } },
      shared: true,
    },
    {
      name: "channel override of team isolation",
      config: {
        teams: {
          "team-1": {
            threadSessionPolicy: "thread",
            channels: { [channelConversationId]: { threadSessionPolicy: "channel" } },
          },
        },
      },
      shared: true,
    },
    {
      name: "channel isolation overriding global and team opt-in",
      config: {
        threadSessionPolicy: "channel",
        teams: {
          "team-1": {
            threadSessionPolicy: "channel",
            channels: { [channelConversationId]: { threadSessionPolicy: "thread" } },
          },
        },
      },
      shared: false,
    },
    {
      name: "team isolation overriding global opt-in",
      config: {
        threadSessionPolicy: "channel",
        teams: { "team-1": { threadSessionPolicy: "thread" } },
      },
      shared: false,
    },
    {
      name: "wildcard channel opt-in",
      config: { teams: { "*": { channels: { "*": { threadSessionPolicy: "channel" } } } } },
      shared: true,
    },
  ])("honors $name while preserving reply destinations", async ({ config, shared }) => {
    const { deps, recordInboundSession, conversationStore } = createMessageHandlerDeps({
      channels: { msteams: { groupPolicy: "open", ...config } },
    });
    const handler = createMSTeamsMessageHandler(deps);

    for (const root of ["root-a", "root-b"]) {
      await handler({
        activity: buildChannelActivity({
          id: `reply-${root}`,
          replyToId: "nested-reply",
          conversation: {
            id: `${channelConversationId};messageid=${root}`,
            conversationType: "channel",
          },
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);
    }

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    for (const [index, root] of ["root-a", "root-b"].entries()) {
      const sessionKey = shared ? channelSessionKey : `${channelSessionKey}:thread:${root}`;
      expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[index]?.[0].ctx).toMatchObject({
        SessionKey: sessionKey,
        MessageThreadId: root,
      });
      expect(recordInboundSession).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ sessionKey }),
      );
      expect(conversationStore.upsert).toHaveBeenCalledWith(
        channelConversationId,
        expect.objectContaining({ teamId: "team-1", threadId: root }),
      );
    }
  });

  it.each(["personal", "groupChat"])(
    "leaves %s sessions unchanged under channel opt-in",
    async (kind) => {
      const { deps } = createMessageHandlerDeps({
        channels: {
          msteams: { allowFrom: ["*"], groupPolicy: "open", threadSessionPolicy: "channel" },
        },
      });
      const handler = createMSTeamsMessageHandler(deps);
      await handler({
        activity: buildChannelActivity({
          conversation: { id: "19:chat@thread.v2", conversationType: kind },
          channelData: {},
          replyToId: "quoted-message",
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].ctx).toMatchObject({
        SessionKey:
          kind === "personal"
            ? "agent:main:msteams:direct:user-aad"
            : "agent:main:msteams:group:19:chat@thread.v2",
      });
    },
  );
});
