import { expectDefined } from "@openclaw/normalization-core";
import type { App } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { assert, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackEventScope } from "../event-scope.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext as createInboundSlackCtx,
  createSlackSessionStoreFixture,
  createSlackTestAccount as createSlackAccount,
} from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

describe("Slack inbound conversation links", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-conversation-link-");

  it.each([
    { channel: "C123", channelType: "channel", threadTs: "9.000" },
    { channel: "D123", channelType: "im", threadTs: undefined },
    { channel: "C123", channelType: "channel", threadTs: undefined },
  ] as const)(
    "links the $channel Slack conversation without an API lookup",
    async ({ channel, channelType, threadTs }) => {
      const { storePath } = storeFixture.makeTmpStorePath();
      const fetch = vi
        .fn<NonNullable<WebClientOptions["fetch"]>>()
        .mockRejectedValue(new Error("the return link must not call Slack's API"));
      const ctx = createInboundSlackCtx({
        cfg: { session: { store: storePath }, channels: { slack: { enabled: true } } },
        app: {
          client: { token: "unscoped-fixture" },
          webClientOptions: { fetch },
        } as unknown as App,
        defaultRequireMention: false,
      });
      ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
      ctx.resolveUserName = async () => ({ name: "Alice" });
      const eventScope = {
        teamId: "T123ENTERPRISE",
        client: {
          token: "event-fixture",
          slackApiUrl: "https://slack-gov.com/api/",
        } as SlackEventScope["client"],
      };
      const message: SlackMessageEvent = {
        type: "message",
        user: "U1",
        text: "hi",
        channel,
        channel_type: channelType,
        ts: "10.000",
        thread_ts: threadTs,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackAccount({ replyToMode: "off" }),
        message,
        opts: { source: "message", eventScope },
      });

      assert(prepared);
      const expectedLink = {
        url: `https://slack-gov.com/app_redirect?channel=${channel}&team=T123ENTERPRISE`,
        label: "Slack",
      };
      expect(prepared.ctxPayload.ConversationLink).toEqual(expectedLink);
      expect(fetch).not.toHaveBeenCalled();

      await upsertSessionEntry({
        storePath,
        sessionKey: expectDefined(prepared.ctxPayload.SessionKey, "session key"),
        entry: {
          sessionId: "existing-slack-session",
          updatedAt: Date.now(),
          conversationLink: expectedLink,
        },
      });
      fetch.mockClear();
      const repeated = await prepareSlackMessage({
        ctx,
        account: createSlackAccount({ replyToMode: "off" }),
        message,
        opts: { source: "message", eventScope },
      });
      assert(repeated);
      expect(repeated.ctxPayload.ConversationLink).toEqual(expectedLink);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
