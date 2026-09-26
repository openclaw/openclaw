import { expectDefined } from "@openclaw/normalization-core";
import type { App } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
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
  beforeAll(() => storeFixture.setup());
  afterAll(() => storeFixture.cleanup());

  it.each([
    { replyToMode: "all", channel: "C123", threadTs: undefined, target: "10.000", threaded: true },
    {
      replyToMode: "first",
      channel: "C123",
      threadTs: undefined,
      target: "10.000",
      threaded: true,
    },
    { replyToMode: "off", channel: "C123", threadTs: "9.000", target: "9.000", threaded: true },
    { replyToMode: "off", channel: "D123", threadTs: "9.000", target: "9.000", threaded: true },
    { replyToMode: "off", channel: "C123", threadTs: undefined, target: "10.000", threaded: false },
  ] as const)(
    "captures the $replyToMode $channel conversation link for thread $threadTs using the scoped client",
    async ({ replyToMode, channel, threadTs, target, threaded }) => {
      const { storePath } = storeFixture.makeTmpStorePath();
      const permalink = "https://workspace.slack.com/archives/C123/p10000000";
      const fetch = vi
        .fn<NonNullable<WebClientOptions["fetch"]>>()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, permalink })));
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
          slackApiUrl: "https://slack-api.example/api/",
        } as SlackEventScope["client"],
      };
      const message: SlackMessageEvent = {
        type: "message",
        user: "U1",
        text: "hi",
        channel,
        channel_type: channel === "D123" ? "im" : "channel",
        ts: "10.000",
        thread_ts: threadTs,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackAccount({ replyToMode }),
        message,
        opts: { source: "message", eventScope },
      });

      assert(prepared);
      const expectedLink = {
        url: threaded ? `${permalink}?thread_ts=${target}&cid=${channel}` : permalink,
        label: threaded ? "Slack Thread" : "Slack Message",
      };
      expect(prepared.ctxPayload.ConversationLink).toEqual(expectedLink);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "https://slack-api.example/api/chat.getPermalink",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer event-fixture" }),
        }),
      );
      expect(
        Object.fromEntries(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)),
      ).toEqual({
        team_id: "T123ENTERPRISE",
        channel,
        message_ts: target,
      });

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
        account: createSlackAccount({ replyToMode }),
        message,
        opts: { source: "message", eventScope },
      });
      assert(repeated);
      expect(repeated.ctxPayload.ConversationLink).toEqual(expectedLink);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("continues message preparation without retrying a rate-limited Slack permalink request", async () => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const fetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    );
    const ctx = createInboundSlackCtx({
      cfg: { session: { store: storePath }, channels: { slack: { enabled: true } } },
      app: { client: { token: "event-fixture" }, webClientOptions: { fetch } } as unknown as App,
    });
    const warn = vi.spyOn(ctx.logger, "warn").mockImplementation(() => {});
    try {
      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackAccount(),
        message: {
          type: "message",
          channel: "D123",
          channel_type: "im",
          user: "U1",
          text: "hi",
          ts: "1.000",
        },
        opts: { source: "message" },
      });
      assert(prepared);
      expect(prepared.ctxPayload.ConversationLink).toBeUndefined();
      expect(prepared.ctxPayload.BodyForAgent).toBe("hi");
      expect(fetch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { error: expect.stringContaining("rate-limit"), channelId: "D123" },
        "Slack conversation link unavailable",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("honors cancellation while the optional permalink lookup is pending", async () => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const response = createDeferred<Response>();
    const fetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>().mockReturnValue(response.promise);
    const controller = new AbortController();
    const ctx = createInboundSlackCtx({
      cfg: { session: { store: storePath }, channels: { slack: { enabled: true } } },
      app: { client: { token: "event-fixture" }, webClientOptions: { fetch } } as unknown as App,
    });
    const prepared = prepareSlackMessage({
      ctx,
      account: createSlackAccount(),
      message: {
        type: "message",
        channel: "D123",
        channel_type: "im",
        user: "U1",
        text: "hi",
        ts: "1.000",
      },
      opts: { source: "message", abortSignal: controller.signal },
    });
    const result = expect(prepared).rejects.toThrow("link preparation canceled");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error("link preparation canceled"));
    response.resolve(
      new Response(
        JSON.stringify({ ok: true, permalink: "https://workspace.slack.com/archives/D123/p1000" }),
      ),
    );
    await result;
  });
});
