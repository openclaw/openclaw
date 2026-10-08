import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import fs from "node:fs/promises";
import path from "node:path";
import { MessageType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import type { DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  createIngressLifecycle,
  createDiscordHandlerParams,
  createDiscordQueuePreflightContext,
  createDiscordQueuePreflightContextForMessage,
} from "./message-handler.test-helpers.js";

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [{ id: `att-${messageId}` }],
    },
  };
}

function createTextMessageData(messageId: string, channelId = "ch-1") {
  const data = createMessageData(messageId, channelId);
  data.message.attachments = [];
  return data;
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    vi.useRealTimers();
  });

  it("preserves prepared context and forwards handler cancellation through the run queue", async () => {
    const message = createDiscordMessage({
      id: "m-1",
      channelId: "ch-1",
      content: "hello",
      author: { id: "user-1", bot: false },
      referencedMessage: createDiscordMessage({
        id: "parent-1",
        channelId: "ch-1",
        content: "earlier",
        author: { id: "user-2", bot: false },
      }),
    });
    const data = { ...createMessageData(message.id), message };
    const messageAbort = new AbortController();
    const handlerAbort = new AbortController();
    const context = {
      ...createDiscordQueuePreflightContextForMessage(data),
      data,
      message,
      buildContext: vi.fn(),
      abortSignal: messageAbort.signal,
    };
    const started = createDeferred<DiscordMessagePreflightContext>();
    const finish = createDeferred<void>();
    preflightDiscordMessageMock.mockResolvedValue(context);
    processDiscordMessageMock.mockImplementation(
      async (received: DiscordMessagePreflightContext) => {
        started.resolve(received);
        await finish.promise;
      },
    );
    const handler = createDiscordMessageHandler(
      createDiscordHandlerParams({ abortSignal: handlerAbort.signal }),
    );
    try {
      await handler(data as never, {} as never);
      const received = await started.promise;
      expect(received.message.content).toBe("hello");
      expect(received.data.message.content).toBe("hello");
      expect(received.message.referencedMessage?.content).toBe("earlier");
      expect(received.runtime).toBe(context.runtime);
      expect(received.buildContext).toBe(context.buildContext);
      const signal = received.abortSignal;
      expect(signal?.aborted).toBe(false);
      const reason = new Error("handler cancelled");
      handlerAbort.abort(reason);
      expect(signal?.reason).toBe(reason);
    } finally {
      finish.resolve();
      await handler.deactivate();
    }
  });

  it("settles every merged ingress claim when preflight admits the batch", async () => {
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: {
        data: { channel_id: string };
        turnAdoptionLifecycle?: unknown;
      }) => ({
        ...createDiscordQueuePreflightContext(preflightParams.data.channel_id),
        turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
      }),
    );
    processDiscordMessageMock.mockImplementation(
      async (ctx: { turnAdoptionLifecycle?: DiscordIngressLifecycle }) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
      },
    );
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();
    for (const [index, lifecycle] of [first, second].entries()) {
      await expect(
        handler(createTextMessageData(`m-fanout-${index}`) as never, {} as never, {
          turnAdoptionLifecycle: lifecycle,
        }),
      ).resolves.toEqual({ kind: "deferred" });
    }
    await vi.waitFor(() => expect(processDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("returns retryable, never completed, for a dispatch after shutdown", async () => {
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler.deactivate();
    const lifecycle = createIngressLifecycle();

    // Completing here would tombstone a message that never dispatched; the
    // claim must release so a restarted drain replays it.
    const result = await handler(createTextMessageData("m-after-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });

    expect(result).toMatchObject({ kind: "deferred" });
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("reports a genuine pre-admission exception only through onFailed", async () => {
    const failure = new Error("preflight failed");
    preflightDiscordMessageMock.mockRejectedValue(failure);
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-failed") as never, {} as never, {
        turnAdoptionLifecycle: lifecycle,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    expect(lifecycle.onFailed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("settles every buffered claim when cancellation fan-in includes a legacy lifecycle", async () => {
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const cancellable = createIngressLifecycle();
    const legacy = createIngressLifecycle();
    delete (legacy as Partial<typeof legacy>).onCancelled;

    await handler(createTextMessageData("m-cancel-modern") as never, {} as never, {
      turnAdoptionLifecycle: cancellable,
    });
    await handler(createTextMessageData("m-cancel-legacy") as never, {} as never, {
      turnAdoptionLifecycle: legacy,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(cancellable.onCancelled).toHaveBeenCalledTimes(1);
    expect(cancellable.onAbandoned).not.toHaveBeenCalled();
    expect(cancellable.onAdopted).not.toHaveBeenCalled();
    expect(legacy.onAbandoned).toHaveBeenCalledTimes(1);
    expect(legacy.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active debounce flush and cancels it after shutdown", async () => {
    const preflightGate = createDeferred<void>();
    preflightDiscordMessageMock.mockImplementation(async () => {
      await preflightGate.promise;
      return null;
    });
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();
    const handling = handler(createTextMessageData("m-active-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(deactivated).toBe(false);

    preflightGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    const firstPreflight = createDeferred<void>();
    const processedMessageIds: string[] = [];

    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return {
          ...createDiscordQueuePreflightContext(params.data.channel_id),
          messageId,
        };
      },
    );

    processDiscordMessageMock.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("reports a concurrent run failure without leaving busy state stuck", async () => {
    const firstRun = createDeferred<void>();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: ReturnType<typeof createMessageData> }) =>
        createDiscordQueuePreflightContextForMessage(params.data),
    );

    const setStatus = vi.fn();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ activeRuns: 0, busy: false }));
  });

  it("captures current acknowledgement policy for each turn", async () => {
    preflightDiscordMessageMock.mockResolvedValue(null);
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 0 }, ackReactionScope: "off" };
    setRuntimeConfigSnapshot(params.cfg, params.cfg);
    const context = await createBaseDiscordMessageContext();
    const handler = createDiscordMessageHandler(params);
    try {
      for (const scope of ["off", "all", "off"] as const) {
        const cfg = {
          ...params.cfg,
          messages: { ...params.cfg.messages, ackReactionScope: scope },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        await handler({ ...context.data, message: context.message }, context.client);
        expect(preflightDiscordMessageMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ cfg, ackReactionScope: scope }),
        );
      }
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(3);
    } finally {
      await handler.deactivate();
      clearRuntimeConfigSnapshot();
      await fs.rm(path.dirname(context.cfg.session!.store!), { recursive: true, force: true });
    }
  });

  it("applies current inbound timing without losing queued Discord messages", async () => {
    const client = createInternalTestClient();
    const params = createDiscordHandlerParams();
    const dispatched: string[][] = [];
    setRuntimeConfigSnapshot(params.cfg, params.cfg);
    const handler = createDiscordMessageDispatcher({
      ...params,
      testing: {
        preflightDiscordMessage: async ({ data, precedingMessages = [] }) => {
          dispatched.push([...precedingMessages, data.message].map((message) => message.id));
          return null;
        },
      },
    });
    const publish = (inbound: NonNullable<OpenClawConfig["messages"]>["inbound"]) => {
      const cfg = { ...params.cfg, messages: { inbound } };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    const enqueue = (text: string) => {
      const message = new Message(client, {
        id: text,
        channel_id: "c1",
        content: text,
        author: {
          id: "U1",
          username: "alice",
          global_name: null,
          discriminator: "0",
          avatar: null,
        },
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        timestamp: "2026-09-04T00:00:00.000Z",
        edited_timestamp: null,
        type: MessageType.Default,
        tts: false,
        pinned: false,
      });
      return handler({ message, author: message.author, channel_id: message.channelId }, client);
    };
    vi.useFakeTimers();
    try {
      await enqueue("immediate");
      expect(dispatched).toEqual([["immediate"]]);

      publish({ debounceMs: 50 });
      await enqueue("first");
      await vi.advanceTimersByTimeAsync(25);
      expect(dispatched).toEqual([["immediate"]]);
      publish({ debounceMs: 50, byChannel: { discord: 10 } });
      await enqueue("second");
      await vi.advanceTimersByTimeAsync(9);
      expect(dispatched).toEqual([["immediate"]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatched).toEqual([["immediate"], ["first", "second"]]);

      publish({ debounceMs: 50 });
      await enqueue("pending");
      publish({ debounceMs: 0 });
      await enqueue("after disable");
      expect(dispatched).toEqual([
        ["immediate"],
        ["first", "second"],
        ["pending"],
        ["after disable"],
      ]);

      publish({ debounceMs: 50 });
      await enqueue("cancel on shutdown");
      await handler.deactivate();
      await vi.advanceTimersByTimeAsync(50);
      expect(dispatched).toHaveLength(4);
    } finally {
      await handler.deactivate();
      vi.useRealTimers();
      clearRuntimeConfigSnapshot();
    }
  });
});
