import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyFromConfig;

function message(params: {
  text: string;
  root?: string;
  replyToId?: string;
  mentioned?: boolean;
  conversationType?: string;
}): MSTeamsTurnContext {
  return {
    activity: buildChannelActivity({
      id: params.text,
      text: params.text,
      conversation: {
        id: params.root
          ? `${channelConversationId};messageid=${params.root}`
          : channelConversationId,
        conversationType: params.conversationType ?? "channel",
      },
      replyToId: params.replyToId,
      // Keep Graph context out of this pending-history scenario.
      channelData: {},
      ...(params.mentioned ? {} : { entities: [] }),
    }),
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

describe("Teams pending history", () => {
  let resolveStorePath: () => string;
  let handler: ReturnType<typeof createMSTeamsMessageHandler>;

  beforeEach(() => {
    dispatch.mockClear();
    const fixture = createMessageHandlerDeps({
      channels: { msteams: { groupPolicy: "open", requireMention: true, historyLimit: 10 } },
    });
    resolveStorePath = fixture.resolveStorePath;
    handler = createMSTeamsMessageHandler(fixture.deps);
  });

  it.each(["conversation root", "replyToId"])(
    "isolates pending history and cleanup per channel thread using %s",
    async (source) => {
      const thread = (root: string, reply: string) =>
        source === "conversation root" ? { root, replyToId: reply } : { replyToId: root };
      await handler(message({ text: "note in A", ...thread("root-a", "nested-a") }));
      await handler(message({ text: "note in B", ...thread("root-b", "nested-b") }));
      expect(dispatch).not.toHaveBeenCalled();

      await handler(
        message({ text: "question in B", mentioned: true, ...thread("root-b", "other-b") }),
      );
      const inB = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(inB?.Body).toContain("note in B");
      expect(inB?.InboundHistory).toEqual([expect.objectContaining({ body: "note in B" })]);
      for (const field of [
        "Body",
        "BodyForAgent",
        "CommandBody",
        "BodyForCommands",
        "RawBody",
      ] as const) {
        expect(inB?.[field]).not.toContain("note in A");
      }
      const sessionKeyB = `agent:main:msteams:channel:${channelConversationId}:thread:root-b`;
      expect(inB?.SessionKey).toBe(sessionKeyB);
      expect(
        getSessionEntry({
          agentId: "main",
          storePath: resolveStorePath(),
          sessionKey: sessionKeyB,
        }),
      ).toMatchObject({
        delivery: { origin: { provider: "msteams", accountId: "default", threadId: "root-b" } },
      });

      // Consuming B must leave A pending, then consume A exactly once.
      await handler(
        message({ text: "question in A", mentioned: true, ...thread("root-a", "other-a") }),
      );
      const inA = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(inA?.Body).toContain("note in A");
      expect(inA?.Body).not.toContain("note in B");
      expect(inA?.InboundHistory).toEqual([expect.objectContaining({ body: "note in A" })]);
      await handler(
        message({ text: "follow-up in A", mentioned: true, ...thread("root-a", "last-a") }),
      );
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.Body).not.toContain("note in A");
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.InboundHistory).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["channel", "groupChat"])(
    "preserves conversation-wide history for %s messages without a channel thread",
    async (conversationType) => {
      const scope =
        conversationType === "groupChat" ? { root: "quoted-a", replyToId: "quoted-a" } : {};
      await handler(message({ text: "earlier message", conversationType, ...scope }));
      await handler(message({ text: "question", mentioned: true, conversationType }));
      const ctx = dispatch.mock.calls.at(-1)?.[0].ctx;
      expect(ctx?.Body).toContain("earlier message");
      expect(ctx?.InboundHistory).toEqual([expect.objectContaining({ body: "earlier message" })]);
      await handler(message({ text: "next question", mentioned: true, conversationType }));
      expect(dispatch.mock.calls.at(-1)?.[0].ctx.InboundHistory).toEqual([]);
    },
  );
});
