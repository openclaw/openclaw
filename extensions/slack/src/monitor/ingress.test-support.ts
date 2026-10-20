import { App, type AppOptions, type Receiver, type ReceiverEvent } from "@slack/bolt";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { vi } from "vitest";
import { createSlackDurableIngress } from "./ingress.js";

export type SlackIngressQueue = NonNullable<
  Parameters<typeof createSlackDurableIngress>[0]["queue"]
>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

export async function withQueue(run: (queue: SlackIngressQueue) => Promise<void>) {
  await withOpenClawTestState({ label: "slack-ingress" }, async (state) => {
    await run(
      createChannelIngressQueueForTests<SlackIngressPayload>({
        channelId: "slack",
        accountId: "default",
        stateDir: state.stateDir,
      }),
    );
  });
}

export function createReceiverEvent(eventId = "Ev-auth-retry"): ReceiverEvent {
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
    ack: vi.fn(async () => {}),
  };
}

export function attachBoltIngress(
  queue: SlackIngressQueue,
  options: {
    authorize?: AppOptions["authorize"];
    pollIntervalMs?: number;
    adoptionStallTimeoutMs?: number;
  } = {},
) {
  const { authorize, ...ingressOptions } = options;
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: 60_000,
    ...ingressOptions,
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
    authorize:
      authorize ??
      (async () => ({
        botToken: "xoxb-fixture",
        botId: "B_TEST",
        botUserId: "U_BOT",
        teamId: "T_TEST",
      })),
    convoStore: false,
    ignoreSelf: false,
  });
  return {
    app,
    ingress,
    receive: async (event: ReceiverEvent) => {
      if (!receive) {
        throw new Error("Receiver not initialized");
      }
      await receive(event);
    },
  };
}
