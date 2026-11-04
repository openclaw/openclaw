import { App, SocketModeReceiver } from "@slack/bolt";
import { loadGatewaySuspendCoordinatorForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { installSlackTestRuntime } from "../test-runtime.test-support.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { createSlackDurableIngress } from "./ingress.js";
import { createMonitorTestContext } from "./monitor-context.test-support.js";

function createReceiver() {
  const receiver = new SocketModeReceiver({
    appToken: "xapp-fixture",
    processEventErrorHandler: async () => false,
  });
  const ingress = createSlackDurableIngress({ accountId: "default" });
  const app = new App({
    receiver: ingress.wrapReceiver(receiver),
    authorize: async () => ({ botToken: "xoxb-fixture" }),
    convoStore: false,
    ignoreSelf: false,
    clientOptions: {
      fetch: async () => {
        throw new Error("Unexpected Slack API call");
      },
    },
  });
  // EventEmitter.emit discards the receiver's promise. Join its registered
  // listener to observe the complete Bolt dispatch, including errors.
  const ack = vi.fn(async () => {});
  const deliver = async (body: unknown) => {
    for (const receive of receiver.client.listeners("slack_event")) {
      await receive.call(receiver.client, { body, ack });
    }
  };
  return { app, ingress, ack, deliver };
}

it.each(["button", "message shortcut"] as const)(
  "drains an acknowledged %s before suspension and refuses another delivery",
  async (kind) => {
    const { prepareGatewaySuspend, getGatewaySuspendStatus, resumeGatewaySuspend } =
      await loadGatewaySuspendCoordinatorForTest();
    const { app, ack, deliver } = createReceiver();
    const runtime = installSlackTestRuntime();
    const enqueued = vi.spyOn(runtime.system, "enqueueSessionEvent");
    const ctx = createMonitorTestContext({
      app,
      allowFrom: ["*"],
      channelRuntime: runtime.channel,
    });
    ctx.isRuntimePolicyCurrent = () => true;
    ctx.resolveChannelName = async () => ({ type: "im" });
    ctx.resolveUserName = async () => ({ name: "sender" });
    ctx.resolveSlackSystemEventRoute = async () => ({
      agentId: "main",
      sessionKey: "agent:main:fixture",
    });
    const held = createDeferred<void>();
    const reached = createDeferred<void>();
    ctx.readRuntimeContext = async () => {
      reached.resolve();
      await held.promise;
      return ctx;
    };
    registerSlackInteractionEvents({ ctx });
    const thread = "1700000000.000001";
    const message = { ts: "1700000000.000002", thread_ts: thread };
    const body = {
      ...(kind === "button"
        ? {
            type: "block_actions",
            actions: [{ type: "button", action_id: "press", block_id: "controls" }],
          }
        : { type: "message_action", callback_id: "inspect" }),
      channel: { id: "D1" },
      user: { id: "U1" },
      message,
    };
    const processing = deliver(body);
    let suspensionId: string | undefined;
    try {
      await Promise.race([
        reached.promise,
        processing.then(() => {
          throw new Error("Interaction did not reach the handler");
        }),
      ]);
      expect(ack).toHaveBeenCalledTimes(1);
      const prepare = () =>
        prepareGatewaySuspend({
          requestId: "interaction-test",
          drain: true,
          pauseScheduling() {},
          resumeScheduling() {},
        });
      const result = prepare();
      if (result.status === "ready" || result.status === "draining") {
        suspensionId = result.suspensionId;
      }
      expect(result).toMatchObject({
        status: "draining",
        activeCount: 1,
        blockers: [{ kind: "root-request", count: 1 }],
      });
      await deliver(body);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(enqueued).not.toHaveBeenCalled();
      held.resolve();
      await processing;
      expect(enqueued).toHaveBeenCalledTimes(1);
      expect(enqueued.mock.calls[0]?.[1].deliveryContext?.threadId).toBe(thread);
      expect(prepare()).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
      if (!suspensionId) {
        throw new Error("Expected a held suspension");
      }
      expect(getGatewaySuspendStatus(suspensionId)).toMatchObject({ status: "ready" });
      await deliver(body);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(enqueued).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve();
      if (suspensionId) resumeGatewaySuspend(suspensionId);
      await processing;
    }
  },
);

it("joins an acknowledged listener that fails during account stop", async () => {
  const { app, ingress, ack, deliver } = createReceiver();
  const held = createDeferred<void>();
  const reached = createDeferred<void>();
  const failure = new Error("Interaction failed");
  const errors: Error[] = [];
  app.error(async (error) => {
    errors.push(error);
  });
  app.shortcut("inspect", async ({ ack }) => {
    await ack();
    reached.resolve();
    await held.promise;
    throw failure;
  });
  app.shortcut("later", async ({ ack }) => {
    await ack();
  });
  const body = { type: "shortcut", callback_id: "inspect", user: { id: "U1" } };
  const processing = deliver(body);
  try {
    await Promise.race([
      reached.promise,
      processing.then(() => {
        throw new Error("Shortcut did not reach the listener");
      }),
    ]);
    const stopped = ingress.stop().then(() => errors.length);
    await deliver({ ...body, callback_id: "later" });
    expect(ack).toHaveBeenCalledTimes(1);
    held.resolve();
    expect(await stopped).toBe(1);
    expect(errors[0]?.message).toBe(failure.message);
  } finally {
    held.resolve();
    await processing;
    await ingress.stop();
  }
});
