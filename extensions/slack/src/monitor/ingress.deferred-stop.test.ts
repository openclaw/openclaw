import { App, type Receiver, type ReceiverEvent } from "@slack/bolt";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

async function withQueue(run: (queue: SlackIngressQueue) => Promise<void>) {
  await withOpenClawTestState({ label: "slack-deferred-stop" }, async (state) => {
    await run(
      createChannelIngressQueueForTests<SlackIngressPayload>({
        channelId: "slack",
        accountId: "default",
        stateDir: state.stateDir,
      }),
    );
  });
}

function createReceiverEvent(eventId: string): ReceiverEvent {
  return {
    body: {
      type: "event_callback",
      event_id: eventId,
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
    ack: async () => {},
  };
}

function attachIngress(
  queue: SlackIngressQueue,
  processEvent: (event: ReceiverEvent) => Promise<void>,
) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  let receive: ((event: ReceiverEvent) => Promise<void>) | undefined;
  const receiver: Receiver = {
    init: (app) => {
      receive = (event) => app.processEvent(event);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  const app = new App({
    receiver: ingress.wrapReceiver(receiver),
    authorize: async () => ({
      botToken: "xoxb-fixture",
      botId: "B_TEST",
      botUserId: "U_BOT",
      teamId: "T_TEST",
    }),
    convoStore: false,
    ignoreSelf: false,
  });
  vi.spyOn(app, "processEvent").mockImplementation(processEvent);
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

describe("Slack deferred ingress shutdown", () => {
  it("settles a failed session-routed delivery before shutdown without losing retry facts", async () => {
    await withQueue(async (queue) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:failed-session");
        throw new Error("session dispatch failed");
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();
      try {
        await receive(createReceiverEvent("Ev-failed-session"));
        await ingress.waitForIdle();
        await ingress.stop();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "Ev-failed-session",
            attempts: 1,
            lastError: "session dispatch failed",
          }),
        ]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("joins a deferred reply's replay settlement after its Bolt handler returns", async () => {
    await withQueue(async (queue) => {
      const commitStarted = createDeferred<void>();
      const commitGate = createDeferred<void>();
      let settlement: Promise<void> | undefined;
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        if (!lifecycle) {
          throw new Error("Missing Slack ingress lifecycle");
        }
        await lifecycle.onSessionRouted?.("agent:main:slack:deferred-stop");
        lifecycle.onDeferred();
        settlement = (async () => {
          commitStarted.resolve();
          await commitGate.promise;
          await lifecycle.onAdopted();
        })();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();
      let stopped = false;
      let stop: Promise<void> | undefined;
      try {
        await receive(createReceiverEvent("Ev-deferred-settlement"));
        await commitStarted.promise;
        await ingress.waitForIdle();
        stop = ingress.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        commitGate.resolve();
        await settlement;
        await stop;
        expect(stopped).toBe(true);
      } finally {
        commitGate.resolve();
        await settlement;
        await (stop ?? ingress.stop());
      }
    });
  });
});
