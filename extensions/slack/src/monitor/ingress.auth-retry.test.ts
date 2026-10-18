import { WebClient, type WebClientOptions } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import {
  attachBoltIngress,
  createReceiverEvent,
  withQueue,
  type SlackIngressQueue,
} from "./ingress.test-support.js";

function attachIngress(params: {
  queue: SlackIngressQueue;
  authFetch: NonNullable<WebClientOptions["fetch"]>;
  onMessage: () => Promise<void>;
  pollIntervalMs?: number;
}) {
  const authClient = new WebClient("xoxb-fixture", {
    fetch: params.authFetch,
    retryConfig: { retries: 0 },
    slackApiUrl: "https://slack.test/api/",
  });
  const attached = attachBoltIngress(params.queue, {
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
    authorize: async () => {
      await authClient.auth.test();
      return { botToken: "xoxb-fixture", botId: "B_TEST", botUserId: "U_BOT", teamId: "T_TEST" };
    },
  });
  attached.app.message(params.onMessage);
  return attached;
}

describe("Slack ingress authorization failures", () => {
  it.each([
    { name: "rate limit", status: 429 },
    { name: "service outage", status: 503 },
    { name: "connection reset", status: 0 },
  ])("replays a $name during Bolt authorization after restart", async ({ status }) => {
    await withQueue(async (queue) => {
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
        const event = createReceiverEvent();
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
        await restarted.receive(createReceiverEvent());
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
    await withQueue(async (queue) => {
      const authFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async () =>
        Response.json({ ok: false, error: "invalid_auth" }),
      );
      const onMessage = vi.fn(async () => {});
      const { ingress, receive } = attachIngress({ queue, authFetch, onMessage });
      ingress.start();
      try {
        await receive(createReceiverEvent());
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
