import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import type { DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock as preflight,
  processDiscordMessageMock as processMessage,
} from "./message-handler.module-test-helpers.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightContext as PreflightContext } from "./message-handler.preflight.types.js";
import {
  createIngressLifecycle,
  createDiscordHandlerParams,
  createDiscordQueuePreflightContext as queuedContext,
  createDiscordQueuePreflightContextForMessage as messageContext,
} from "./message-handler.test-helpers.js";

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createMessageData(messageId: string, attachments = true) {
  const channelId = "ch-1";
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: attachments ? [{ id: `att-${messageId}` }] : [],
    },
  };
}

function dispatch(
  handler: ReturnType<typeof createDiscordMessageHandler>,
  id: string,
  turnAdoptionLifecycle?: DiscordIngressLifecycle,
) {
  return handler(createMessageData(id, false) as never, {} as never, { turnAdoptionLifecycle });
}

function makeHandler(overrides?: Parameters<typeof createDiscordHandlerParams>[0], debounceMs = 0) {
  const params = createDiscordHandlerParams(overrides);
  params.cfg.messages = { inbound: { debounceMs } };
  return createDiscordMessageHandler(params);
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    preflight.mockImplementation(
      async (params: Pick<PreflightContext, "data" | "turnAdoptionLifecycle">) => ({
        ...messageContext(params.data),
        turnAdoptionLifecycle: params.turnAdoptionLifecycle,
      }),
    );
    processMessage.mockImplementation(
      async (ctx: { turnAdoptionLifecycle?: DiscordIngressLifecycle }) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
      },
    );
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
      ...messageContext(data),
      data,
      message,
      buildContext: vi.fn(),
      abortSignal: messageAbort.signal,
    };
    const started = createDeferred<PreflightContext>();
    const finish = createDeferred<void>();
    preflight.mockResolvedValue(context);
    processMessage.mockImplementation(async (received: PreflightContext) => {
      started.resolve(received);
      await finish.promise;
    });
    const handler = makeHandler({ abortSignal: handlerAbort.signal });
    const handling = handler(data as never, {} as never);
    try {
      const received = await started.promise;
      expect(received).toMatchObject({
        message: { content: "hello", referencedMessage: { content: "earlier" } },
        data: { message: { content: "hello" } },
      });
      expect(received.runtime).toBe(context.runtime);
      expect(received.buildContext).toBe(context.buildContext);
      const signal = received.abortSignal;
      expect(signal?.aborted).toBe(false);
      const reason = new Error("handler cancelled");
      handlerAbort.abort(reason);
      expect(signal?.reason).toBe(reason);
    } finally {
      finish.resolve();
      await handling;
      await handler.deactivate();
    }
  });

  it("keeps queued dispatch pending until adoption without blocking later steering", async () => {
    const started = createDeferred<void>();
    const adopt = createDeferred<void>();
    const finish = createDeferred<void>();
    const followerStarted = createDeferred<void>();
    processMessage.mockImplementation(async (ctx: PreflightContext) => {
      if (ctx.message.id === "m-held") {
        started.resolve();
        await adopt.promise;
        await ctx.turnAdoptionLifecycle?.onAdopted();
        await finish.promise;
      } else {
        followerStarted.resolve();
        await ctx.turnAdoptionLifecycle?.onAdopted();
      }
    });
    const handler = makeHandler();
    let admitted = false;
    const handling = dispatch(handler, "m-held", createIngressLifecycle()).then(() => {
      admitted = true;
    });
    try {
      await started.promise;
      await flushQueueWork();
      expect(admitted).toBe(false);
      // Adoption releases the input lane, not the still-running dispatch.
      adopt.resolve();
      await handling;
      await dispatch(handler, "m-follower", createIngressLifecycle());
      await followerStarted.promise;
      expect(processMessage).toHaveBeenCalledTimes(2);
    } finally {
      adopt.resolve();
      finish.resolve();
      await handling;
      await handler.deactivate();
    }
  });

  it("settles every merged ingress claim when preflight admits the batch", async () => {
    const handler = makeHandler(undefined, 20);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();
    for (const [index, lifecycle] of [first, second].entries()) {
      await expect(dispatch(handler, `m-fanout-${index}`, lifecycle)).resolves.toEqual({
        kind: "deferred",
      });
    }
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(1));
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it.each(["stopped", "flushing"] as const)(
    "cancels rather than completes a %s dispatch",
    async (phase) => {
      const gate = createDeferred<void>();
      if (phase === "flushing") {
        preflight.mockImplementation(async () => {
          await gate.promise;
          return null;
        });
      }
      const handler = makeHandler();
      const lifecycle = createIngressLifecycle();
      if (phase === "stopped") {
        await handler.deactivate();
      }
      const handling = dispatch(handler, "m-stop", lifecycle);
      if (phase === "flushing") {
        await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(1));
        let stopped = false;
        const stopping = handler.deactivate().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        gate.resolve();
        await Promise.all([handling, stopping]);
        expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
      } else {
        expect(await handling).toMatchObject({ kind: "deferred" });
      }
      expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
      expect(lifecycle.onAdopted).not.toHaveBeenCalled();
    },
  );

  it("reports a genuine pre-admission exception only through onFailed", async () => {
    const failure = new Error("preflight failed");
    preflight.mockRejectedValue(failure);
    const handler = makeHandler();
    const lifecycle = createIngressLifecycle();

    await expect(dispatch(handler, "m-failed", lifecycle)).resolves.toEqual({ kind: "deferred" });

    expect(lifecycle.onFailed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("settles every buffered claim when cancellation fan-in includes a legacy lifecycle", async () => {
    const handler = makeHandler(undefined, 60_000);
    const cancellable = createIngressLifecycle();
    const legacy = createIngressLifecycle();
    delete (legacy as Partial<typeof legacy>).onCancelled;

    await dispatch(handler, "m-cancel-modern", cancellable);
    await dispatch(handler, "m-cancel-legacy", legacy);
    await handler.deactivate();

    expect(preflight).not.toHaveBeenCalled();
    expect(cancellable.onCancelled).toHaveBeenCalledTimes(1);
    expect(cancellable.onAbandoned).not.toHaveBeenCalled();
    expect(cancellable.onAdopted).not.toHaveBeenCalled();
    expect(legacy.onAbandoned).toHaveBeenCalledTimes(1);
    expect(legacy.onAdopted).not.toHaveBeenCalled();
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    const firstPreflight = createDeferred<void>();
    const processedMessageIds: string[] = [];

    preflight.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return { ...queuedContext(params.data.channel_id), messageId };
      },
    );

    processMessage.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = makeHandler();

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await flushQueueWork();
    expect(preflight).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await flushQueueWork();
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("reports a concurrent run failure without leaving busy state stuck", async () => {
    const firstRun = createDeferred<void>();
    processMessage
      .mockImplementationOnce(async (ctx: PreflightContext) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);

    const setStatus = vi.fn();
    const handler = makeHandler({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processMessage).toHaveBeenCalledTimes(2);
    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await flushQueueWork();
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ activeRuns: 0, busy: false }));
  });

  it("captures current acknowledgement policy for each turn", async () => {
    preflight.mockResolvedValue(null);
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 0 }, ackReactionScope: "off" };
    setRuntimeConfigSnapshot(params.cfg, params.cfg);
    const handler = createDiscordMessageHandler(params);
    try {
      for (const scope of ["off", "all", "off"] as const) {
        const cfg = {
          ...params.cfg,
          messages: { ...params.cfg.messages, ackReactionScope: scope },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        await dispatch(handler, "1001");
        expect(preflight).toHaveBeenLastCalledWith(
          expect.objectContaining({ cfg, ackReactionScope: scope }),
        );
      }
      expect(preflight).toHaveBeenCalledTimes(3);
    } finally {
      await handler.deactivate();
      clearRuntimeConfigSnapshot();
    }
  });

  it("applies current inbound timing without losing queued Discord messages", async () => {
    const client = createInternalTestClient();
    const params = createDiscordHandlerParams();
    const dispatched: string[][] = [];
    setRuntimeConfigSnapshot(params.cfg, params.cfg);
    preflight.mockImplementation(async ({ data, precedingMessages = [] }) => {
      dispatched.push([...precedingMessages, data.message].map((message) => message.id));
      return null;
    });
    const handler = createDiscordMessageDispatcher(params);
    const publish = (inbound: NonNullable<OpenClawConfig["messages"]>["inbound"]) => {
      const cfg = { ...params.cfg, messages: { inbound } };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    const enqueue = (text: string) => {
      const message = createDiscordMessage(
        {
          id: text,
          channelId: "c1",
          content: text,
          author: { id: "U1", username: "alice", bot: false },
          timestamp: "2026-09-04T00:00:00.000Z",
        },
        client,
      );
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
