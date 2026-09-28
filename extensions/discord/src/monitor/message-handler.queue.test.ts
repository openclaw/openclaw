import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordIngressLifecycle } from "./ingress.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
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

  it.each(["message", "handler"] as const)(
    "preserves prepared context and forwards %s cancellation through the run queue",
    async (cancelSource) => {
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
        const reason = new Error(`${cancelSource} cancelled`);
        (cancelSource === "message" ? messageAbort : handlerAbort).abort(reason);
        expect(signal?.reason).toBe(reason);
      } finally {
        finish.resolve();
        await handler.deactivate();
      }
    },
  );

  it.each([true, false])(
    "settles every merged ingress claim when preflight admits=%s",
    async (admitted) => {
      const params = createDiscordHandlerParams();
      params.cfg.messages = { inbound: { debounceMs: 20 } };
      preflightDiscordMessageMock.mockImplementation(
        async (preflightParams: {
          data: { channel_id: string };
          turnAdoptionLifecycle?: unknown;
        }) =>
          admitted
            ? {
                ...createDiscordQueuePreflightContext(preflightParams.data.channel_id),
                turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
              }
            : null,
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
      await vi.waitFor(() =>
        expect(
          admitted ? processDiscordMessageMock : preflightDiscordMessageMock,
        ).toHaveBeenCalledTimes(1),
      );
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(first.onAdopted).toHaveBeenCalledTimes(1);
      expect(second.onAdopted).toHaveBeenCalledTimes(1);
    },
  );

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
});
