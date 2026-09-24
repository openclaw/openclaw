import { App, type Receiver, type ReceiverEvent } from "@slack/bolt";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { createSlackDurableIngress } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

function attachIngress(params: {
  queue: SlackIngressQueue;
  authFetch: NonNullable<WebClientOptions["fetch"]>;
  onMessage: () => Promise<void>;
  pollIntervalMs?: number;
}) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue: params.queue,
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
  });
  let receive: ((event: ReceiverEvent) => Promise<void>) | undefined;
  const receiver: Receiver = {
    init: (app) => {
      receive = (event) => app.processEvent(event);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  const authClient = new WebClient("xoxb-fixture", {
    fetch: params.authFetch,
    retryConfig: { retries: 0 },
    slackApiUrl: "https://slack.test/api/",
  });
  const app = new App({
    receiver: ingress.wrapReceiver(receiver),
    authorize: async () => {
      await authClient.auth.test();
      return { botToken: "xoxb-fixture", botId: "B_TEST", botUserId: "U_BOT", teamId: "T_TEST" };
    },
    convoStore: false,
    ignoreSelf: false,
  });
  app.message(params.onMessage);
  return {
    ingress,
    receive: async (event: ReceiverEvent) => {
      if (!receive) {
        throw new Error("Receiver not initialized");
      }
      await receive(event);
    },
  };
}

function createEvent(): ReceiverEvent {
  return {
    body: {
      type: "event_callback",
      event_id: "Ev-auth-retry",
      team_id: "T_TEST",
      api_app_id: "A_TEST",
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_TEST",
        ts: "1700000000.004001",
        text: "hello",
      },
    },
    ack: vi.fn(async () => {}),
  };
}

describe("Slack ingress authorization failures", () => {
  it.each([
    { name: "rate limit", status: 429 },
    { name: "service outage", status: 503 },
    { name: "connection reset", status: 0 },
  ])("replays a $name during Bolt authorization after restart", async ({ status }) => {
    await withOpenClawTestState({ label: "slack-auth-retry" }, async (state) => {
      const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
        channelId: "slack",
        accountId: "default",
        stateDir: state.stateDir,
      });
      let available = false;
      const authFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async () => {
        if (available) {
          return Response.json({ ok: true, team_id: "T_TEST", user_id: "U_BOT" });
        }
        if (status === 0) {
          throw new Error("fetch failed", {
            cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
          });
        }
        return new Response("Slack is temporarily unavailable", {
          status,
          headers: { "retry-after": "0" },
        });
      });
      const onMessage = vi.fn(async () => {});
      const first = attachIngress({ queue, authFetch, onMessage });
      let restarted: ReturnType<typeof attachIngress> | undefined;
      first.ingress.start();
      try {
        const event = createEvent();
        await first.receive(event);
        await first.ingress.waitForIdle();
        await first.ingress.stop();
        expect(event.ack).toHaveBeenCalledTimes(1);
        expect(onMessage).not.toHaveBeenCalled();
        expect(await queue.listFailed?.()).toEqual([]);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "Ev-auth-retry", attempts: 1 }),
        ]);

        available = true;
        restarted = attachIngress({ queue, authFetch, onMessage, pollIntervalMs: 25 });
        restarted.ingress.start();
        await vi.waitFor(
          async () => {
            await restarted?.ingress.waitForIdle();
            expect(onMessage).toHaveBeenCalledTimes(1);
            expect(await queue.listPending()).toEqual([]);
          },
          { timeout: 15_000, interval: 100 },
        );
        await restarted.receive(createEvent());
        await restarted.ingress.waitForIdle();
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(authFetch).toHaveBeenCalledTimes(2);
      } finally {
        await first.ingress.stop();
        await restarted?.ingress.stop();
      }
    });
  });

  it("still rejects invalid credentials without dispatching or retrying the message", async () => {
    await withOpenClawTestState({ label: "slack-auth-invalid" }, async (state) => {
      const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
        channelId: "slack",
        accountId: "default",
        stateDir: state.stateDir,
      });
      const authFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async () =>
        Response.json({ ok: false, error: "invalid_auth" }),
      );
      const onMessage = vi.fn(async () => {});
      const { ingress, receive } = attachIngress({ queue, authFetch, onMessage });
      ingress.start();
      try {
        await receive(createEvent());
        await ingress.waitForIdle();
        expect(onMessage).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([
          expect.objectContaining({ id: "Ev-auth-retry", reason: "slack-auth" }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });
});
