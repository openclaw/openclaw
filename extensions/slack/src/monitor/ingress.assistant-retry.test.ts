import type { ReceiverEvent } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { registerSlackWorkspaceEvents } from "./events.js";
import { attachBoltIngress, withQueue, type SlackIngressQueue } from "./ingress.test-support.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";

function attachWorkspaceIngress(
  queue: SlackIngressQueue,
  fetch: NonNullable<WebClientOptions["fetch"]>,
  pollIntervalMs = 60_000,
) {
  const attached = attachBoltIngress(queue, {
    pollIntervalMs,
    clientOptions: {
      fetch,
      retryConfig: { retries: 0 },
      slackApiUrl: "https://slack.test/api/",
    },
  });
  const ctx = createMonitorTestContext({
    cfg: {},
    app: attached.app,
    botToken: "xoxb-fixture",
    teamId: "T_TEST",
    apiAppId: "A_TEST",
  });
  ctx.recordSlackAgentView = vi.fn(async () => {});
  registerSlackWorkspaceEvents({ ctx });
  return attached;
}

describe("Slack suggested-prompt durable recovery", () => {
  it.each(["assistant", "home"] as const)(
    "replays a failed %s update after restart",
    async (kind) => {
      await withQueue(async (queue) => {
        let available = false;
        const fetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async (input) => {
          expect(new URL(String(input)).pathname).toBe(
            "/api/assistant.threads.setSuggestedPrompts",
          );
          if (available) {
            return Response.json({ ok: true });
          }
          return kind === "assistant"
            ? Response.json({ ok: false, error: "internal_error" })
            : new Response("rate limited", { status: 429 });
        });
        const event: ReceiverEvent = {
          body: {
            type: "event_callback",
            event_id: `Ev-${kind}-retry`,
            team_id: "T_TEST",
            api_app_id: "A_TEST",
            event:
              kind === "assistant"
                ? {
                    type: "assistant_thread_started",
                    assistant_thread: {
                      user_id: "U_TEST",
                      channel_id: "D_TEST",
                      thread_ts: "1700000000.004001",
                      context: {},
                    },
                  }
                : { type: "app_home_opened", user: "U_TEST", channel: "D_TEST", tab: "messages" },
          },
          ack: vi.fn(async () => {}),
        };
        const first = attachWorkspaceIngress(queue, fetch);
        let restarted: ReturnType<typeof attachWorkspaceIngress> | undefined;
        first.ingress.start();
        try {
          await first.receive(event);
          await first.ingress.waitForIdle();
          await first.ingress.stop();
          expect(event.ack).toHaveBeenCalledOnce();
          expect(await queue.listPending()).toEqual([
            expect.objectContaining({ id: `Ev-${kind}-retry`, attempts: 1 }),
          ]);

          available = true;
          restarted = attachWorkspaceIngress(queue, fetch, 25);
          restarted.ingress.start();
          await vi.waitFor(
            async () => {
              await restarted?.ingress.waitForIdle();
              expect(await queue.listPending()).toEqual([]);
            },
            { timeout: 15_000, interval: 100 },
          );
          expect(fetch).toHaveBeenCalledTimes(2);
          await restarted.receive(event);
          await restarted.ingress.waitForIdle();
          expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
          await first.ingress.stop();
          await restarted?.ingress.stop();
        }
      });
    },
  );
});
