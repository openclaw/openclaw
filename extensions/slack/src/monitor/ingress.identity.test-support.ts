import { createHmac } from "node:crypto";
import { App, HTTPReceiver, SocketModeReceiver } from "@slack/bolt";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { setSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import { registerSlackMessageEvents } from "./events/messages.js";
import { createSlackDurableIngress } from "./ingress.js";
import type { SlackMessageHandler } from "./message-handler.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import {
  createInboundSlackTestContext,
  createSlackTestAccount,
} from "./message-handler/prepare.test-helpers.js";

/** Real native receivers and message preparation, with Slack Web API lookups kept local. */
export async function withSlackIngressIdentityTestHarness(
  { cfg, runtime, stateDir }: { cfg: OpenClawConfig; runtime: PluginRuntime; stateDir: string },
  run: (harness: {
    contexts: FinalizedMsgContext[];
    receiveSocket: (user: string) => Promise<void>;
    receiveHttp: (validSignature: boolean) => Promise<number>;
  }) => Promise<void>,
) {
  type Queue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
  const queue = createChannelIngressQueueForTests<Parameters<Queue["enqueue"]>[1]>({
    channelId: "slack",
    accountId: "team",
    stateDir,
  });
  const pending = createSlackDurableIngress({ accountId: "team", queue });
  const message: SlackMessageEvent = {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U123",
    ts: "1700000000.001001",
    text: "Assign this session to me",
  };
  await pending.acceptRelayEvent({ deliveryId: "relay-before-restart", message });
  await pending.stop();

  const ingress = createSlackDurableIngress({ accountId: "team", queue });
  const receiver = new SocketModeReceiver({ appToken: "xapp-fixture" });
  const app = new App({
    receiver: ingress.wrapReceiver(receiver),
    authorize: async () => ({ botToken: "xoxb-fixture", botUserId: "B1", teamId: "T1" }),
    convoStore: false,
    ignoreSelf: false,
  });
  const ctx = createInboundSlackTestContext({
    cfg,
    accountId: "team",
    app,
    channelRuntime: runtime.channel,
  });
  setSlackRuntime(runtime);
  ctx.resolveChannelName = async () => ({ name: "direct", type: "im" });
  ctx.resolveUserName = async () => ({ name: "Slack label" });
  ctx.resolveUserAvatar = () => undefined;
  const contexts: FinalizedMsgContext[] = [];
  let onPrepared: (() => void) | undefined;
  async function receive<T>(deliver: (prepared: Promise<void>) => Promise<T>) {
    const prepared = createDeferred<void>();
    onPrepared = prepared.resolve;
    try {
      const result = await deliver(prepared.promise);
      await ingress.waitForIdle();
      return result;
    } finally {
      onPrepared = undefined;
    }
  }
  const handleSlackMessage: SlackMessageHandler = async (inbound, opts) => {
    const result = await prepareSlackMessage({
      ctx,
      account: { ...createSlackTestAccount(), accountId: "team" },
      message: inbound,
      opts,
    });
    if (result) {
      contexts.push(result.ctxPayload);
      onPrepared?.();
    }
  };
  registerSlackMessageEvents({ ctx, handleSlackMessage });
  ingress.attachRelayDispatch(async (inbound) => {
    await handleSlackMessage(inbound as unknown as SlackMessageEvent, { source: "message" });
  });
  const http = new HTTPReceiver({ signingSecret: "synthetic-signing-secret" });
  ingress.wrapReceiver(http).init(app);
  let sequence = 0;
  const envelope = (user: string) => ({
    type: "event_callback",
    event_id: `Ev-${++sequence}`,
    team_id: "T1",
    api_app_id: "A1",
    event: { ...message, user, ts: `1700000000.00100${sequence + 1}` },
  });
  ingress.start();
  try {
    await ingress.waitForIdle();
    await run({
      contexts,
      receiveSocket: (user) =>
        receive(async (prepared) => {
          // The SDK emits socket events synchronously; completion belongs to preparation.
          receiver.client.emit("slack_event", { body: envelope(user), ack: async () => {} });
          await prepared;
        }),
      receiveHttp: async (validSignature) => {
        const body = JSON.stringify(envelope("U123"));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const request = createMockIncomingRequest([body]);
        request.method = "POST";
        request.url = "/slack/events";
        request.headers = {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": validSignature
            ? `v0=${createHmac("sha256", "synthetic-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`
            : "v0=invalid",
        };
        const response = createMockServerResponse();
        const complete = createDeferred<void>();
        response.writeHead = (code: number) => {
          response.statusCode = code;
          return response;
        };
        response.end = () => {
          complete.resolve();
          return response;
        };
        return await receive(async (prepared) => {
          http.requestListener(request, response);
          await complete.promise;
          if (validSignature && response.statusCode === 200) {
            await prepared;
          }
          return response.statusCode;
        }).finally(() => request.destroy());
      },
    });
  } finally {
    await ingress.stop();
  }
}
