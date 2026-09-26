import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover debounce partitioning by reply target.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

function createTextMessageData(
  messageId: string,
  channelId = "ch-1",
  authorId = "user-1",
  content = "hello",
) {
  return {
    channel_id: channelId,
    author: { id: authorId },
    message: {
      id: messageId,
      author: { id: authorId, bot: false },
      content,
      channel_id: channelId,
      attachments: [],
    },
  };
}

function createPreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: { discord: discordConfig },
    messages: { inbound: { debounceMs: 0 } },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
  };
}

describe("Discord reply-target debounce partitioning", () => {
  beforeEach(() => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
  });

  it("keeps replies to a different message out of an ordinary debounced batch", async () => {
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        message: preflightParams.data.message,
        messageText: preflightParams.data.message.content,
      }),
    );
    const handler = createDiscordMessageHandler(params);
    const ordinary = createTextMessageData("m-ordinary");
    const reply = createTextMessageData("m-other-bot-reply");
    Object.assign(reply.message, {
      messageReference: {
        type: 0,
        message_id: "m-other-bot",
        channel_id: reply.channel_id,
      },
      referencedMessage: {
        id: "m-other-bot",
        author: { id: "other-bot", bot: true },
      },
    });

    await handler(ordinary as never, {} as never);
    await handler(reply as never, {} as never);

    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(2);
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["hello", "hello"]);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
  });

  it("preserves conversation-wide admission order across interleaved senders in one channel", async () => {
    // Releasing the per-channel ingress lane on defer (deferredLaneOccupancy:
    // "release" in ingress.ts) lets independent per-author debounce buffers
    // admit and flush concurrently. Without the cross-sender flush guard, a
    // later sender's message (B1) could flush ahead of an earlier sender's
    // still-buffering message (A1), inverting conversation order.
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 300 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        message: preflightParams.data.message,
        messageText: preflightParams.data.message.content,
      }),
    );
    const handler = createDiscordMessageHandler(params);
    const a1 = createTextMessageData("order-a1", "ch-1", "user-a", "A1");
    const b1 = createTextMessageData("order-b1", "ch-1", "user-b", "B1");
    const a2 = createTextMessageData("order-a2", "ch-1", "user-a", "A2");

    await handler(a1 as never, {} as never);
    await handler(b1 as never, {} as never);
    await handler(a2 as never, {} as never);

    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(3);
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["A1", "B1", "A2"]);
  });

  it("keeps a different-author arrival waiting on an already-flushing batch's admission, not just its onFlush start", async () => {
    // onFlush firing only means the debounce timer elapsed; the earlier
    // batch's own preflight can still be in flight. A later different-key
    // arrival must wait for that flush's admission (via the lane record),
    // not skip ahead the moment onFlush starts and flushKey becomes a no-op
    // because the earlier batch already left the debouncer's pending map.
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 50 } };
    const a1Gate = createDeferred<void>();
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => {
        if (preflightParams.data.message.content === "A1") {
          await a1Gate.promise;
        }
        return {
          ...createPreflightContext(preflightParams.data.channel_id),
          message: preflightParams.data.message,
          messageText: preflightParams.data.message.content,
        };
      },
    );
    const handler = createDiscordMessageHandler(params);
    const a1 = createTextMessageData("gap-a1", "ch-1", "user-a", "A1");
    const b1 = createTextMessageData("gap-b1", "ch-1", "user-b", "B1");

    await handler(a1 as never, {} as never);
    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(1);
    // A1's flush has started (onFlush fired) and is now blocked inside its
    // own preflight on a1Gate, so its admission has not settled yet.
    let b1Done = false;
    const b1Handled = handler(b1 as never, {} as never).then(() => {
      b1Done = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(b1Done).toBe(false);
    expect(preflightDiscordMessageMock.mock.calls.length).toBe(1);
    a1Gate.resolve();
    await b1Handled;
    expect(b1Done).toBe(true);
    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(2);
  });

  it("does not dispatch a lane-waiting message once the handler deactivates during its wait", async () => {
    // Finding 2: after the flushKey/admission await, the entry's abort
    // signal must be rechecked before enqueueing — deactivation can land
    // while the await is pending, before the new key has a buffer for
    // cancelKey to remove.
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 50 } };
    const a1Gate = createDeferred<void>();
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => {
        if (preflightParams.data.message.content === "A1") {
          await a1Gate.promise;
        }
        return {
          ...createPreflightContext(preflightParams.data.channel_id),
          message: preflightParams.data.message,
          messageText: preflightParams.data.message.content,
        };
      },
    );
    const handler = createDiscordMessageHandler(params);
    const a1 = createTextMessageData("deact-a1", "ch-1", "user-a", "A1");
    const b1 = createTextMessageData("deact-b1", "ch-1", "user-b", "B1");

    await handler(a1 as never, {} as never);
    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(1);
    const b1Handled = handler(b1 as never, {} as never);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const deactivation = handler.deactivate();
    a1Gate.resolve();
    await Promise.all([b1Handled, deactivation]);

    // B's lane-wait resolves after deactivation aborted the entry's signal,
    // so it must return without ever entering preflight; A's own preflight
    // had already started before deactivation and also aborts before
    // enqueueing, so neither message reaches processDiscordMessage.
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["A1"]);
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });
});
