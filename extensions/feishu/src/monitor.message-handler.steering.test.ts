import {
  createInboundDebouncer,
  type InboundDebounceCreateParams,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { feishuDedupeState } from "./dedup-state.js";
import * as dedup from "./dedup.js";
import { hasProcessedFeishuMessage } from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuDurableIngress } from "./feishu-ingress.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type HandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type Turn = Parameters<HandlerContext["handleMessage"]>[0];
type Entry = Parameters<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>[0][number];
type Queue = NonNullable<Parameters<typeof createFeishuDurableIngress>[0]["queue"]>;
type Payload = Parameters<Queue["enqueue"]>[1];
type Event = FeishuMessageEvent & { event_id: string; event_type: string };

function message(
  id: string,
  options: {
    messageId?: string;
    sender?: string;
    chatType?: FeishuMessageEvent["message"]["chat_type"];
    rootId?: string;
    threadId?: string;
    messageType?: string;
  } = {},
): Event {
  return {
    event_id: id,
    event_type: "im.message.receive_v1",
    sender: { sender_id: { open_id: options.sender ?? "ou-user" }, sender_type: "user" },
    message: {
      message_id: options.messageId ?? `om-${id}`,
      chat_id: "oc-chat",
      chat_type: options.chatType ?? "group",
      message_type: options.messageType ?? "text",
      content: JSON.stringify(
        options.messageType === "file" ? { file_key: `file-${id}` } : { text: id },
      ),
      root_id: options.rootId ?? "om-root",
      thread_id: options.threadId,
    },
  };
}

async function withIngress(
  run: (harness: ReturnType<typeof createHarness>) => Promise<void>,
  options: { buffered?: boolean; cfg?: ClawdbotConfig } = {},
) {
  vi.useFakeTimers();
  const stateDir = tempDirs.make("openclaw-feishu-steering-");
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  feishuDedupeState.reset();
  const harness = createHarness(stateDir, options);
  try {
    await run(harness);
  } finally {
    harness.releaseAll();
    await harness.debouncer.drain();
    await harness.ingress.stop();
    await Promise.allSettled(harness.tracked);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    feishuDedupeState.reset();
    vi.useRealTimers();
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

function createHarness(stateDir: string, options: { buffered?: boolean; cfg?: ClawdbotConfig }) {
  const cfg =
    options.cfg ??
    ({
      channels: { feishu: { groupSessionScope: "group_topic" } },
    } as ClawdbotConfig);
  const queue = createChannelIngressQueueForTests<Payload>({
    channelId: "feishu",
    accountId: "default",
    stateDir,
  });
  const received = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const receiving = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const cancellation = new Map<string, AbortController>();
  const controls: Array<ReturnType<typeof createDeferred<void>>> = [];
  const tracked: Promise<void>[] = [];
  const active = new Set<Promise<void>>();
  const eventKeys = new Map<string, string>();
  let debouncer!: ReturnType<typeof createInboundDebouncer<Entry>>;
  const handleMessage = vi.fn(async (turn: Turn) => {
    await turn.turnAdoptionLifecycle?.onAdopted();
  });
  const fetchMessage = vi.fn<NonNullable<HandlerContext["fetchMessage"]>>();
  const error = vi.fn();
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: {
      resolveInboundDebounceMs: () => (options.buffered ? 3_000 : 0),
      createInboundDebouncer: (params: InboundDebounceCreateParams<Entry>) => {
        debouncer = createInboundDebouncer<Entry>({
          ...params,
          buildKey: (entry) => {
            const key = params.buildKey(entry);
            if (key) {
              eventKeys.set((entry as { event: Event }).event.event_id, key);
            }
            return key;
          },
        });
        return debouncer;
      },
    },
  } as unknown as PluginRuntime["channel"];
  const handler = createFeishuMessageReceiveHandler({
    cfg,
    channelRuntime,
    accountId: "default",
    chatHistories: new Map(),
    runtime: { ...createNonExitingRuntimeEnv(), log: vi.fn(), error },
    handleMessage,
    fetchMessage,
    resolveDebounceText: ({ event }) =>
      (JSON.parse(event.message.content) as { text: string }).text,
    hasProcessedMessage: hasProcessedFeishuMessage,
    getBotOpenId: () => "ou-bot",
    trackTask: (task) => {
      tracked.push(task);
      active.add(task);
      void task.then(
        () => active.delete(task),
        () => active.delete(task),
      );
    },
    resolveIngressLifecycle: (data) => {
      const lifecycle = ingress.resolveLifecycle(data);
      const controller = cancellation.get((data as Event).event_id);
      return lifecycle && controller
        ? { ...lifecycle, abortSignal: AbortSignal.any([lifecycle.abortSignal, controller.signal]) }
        : lifecycle;
    },
  });
  const ingress = createFeishuDurableIngress({
    accountId: "default",
    queue,
    dispatcher: {
      invoke: async (data: unknown) => {
        const event = data as Event;
        receiving.get(event.event_id)?.resolve();
        const result = await handler(event);
        received.get(event.event_id)?.resolve();
        return result;
      },
    } as never,
    runtime: { log: vi.fn(), error },
    pollIntervalMs: 60_000,
  });
  ingress.start();
  return {
    ingress,
    queue,
    debouncer,
    handleMessage,
    fetchMessage,
    error,
    tracked,
    active,
    gate: () => {
      const gate = createDeferred<void>();
      controls.push(gate);
      return gate;
    },
    releaseAll: () => controls.forEach((gate) => gate.resolve()),
    send: async (event: Event) => {
      const receipt = createDeferred<void>();
      received.set(event.event_id, receipt);
      receiving.set(event.event_id, createDeferred<void>());
      cancellation.set(event.event_id, new AbortController());
      expect(await ingress.invokeWebhook(event)).toMatchObject({ kind: "durable" });
      await receipt.promise;
    },
    receiving: (eventId: string) => {
      const started = receiving.get(eventId);
      if (!started) {
        throw new Error(`Missing receipt for ${eventId}`);
      }
      return started.promise;
    },
    abort: (eventId: string) =>
      cancellation.get(eventId)?.abort(new Error("test ingress cancelled")),
    key: (eventId: string) => eventKeys.get(eventId),
    flush: (eventId: string) => {
      const key = eventKeys.get(eventId);
      if (!key) {
        throw new Error(`Missing debounce key for ${eventId}`);
      }
      return debouncer.flushKey(key);
    },
  };
}

describe("Feishu durable receipt and ordered live-run admission", () => {
  it("dispatches successive same-topic messages before the adopted first run completes", async () => {
    await withIngress(async (h) => {
      const firstRunning = h.gate();
      const finishFirst = h.gate();
      const secondDeferred = h.gate();
      const finishSecond = h.gate();
      const thirdDispatched = h.gate();
      let firstComplete = false;
      h.handleMessage.mockImplementation(async (turn) => {
        if (turn.event.message.message_id === "om-first") {
          await turn.turnAdoptionLifecycle?.onAdopted();
          firstRunning.resolve();
          await finishFirst.promise;
          firstComplete = true;
        } else if (turn.event.message.message_id === "om-second") {
          expect(firstComplete).toBe(false);
          turn.turnAdoptionLifecycle?.onDeferred();
          secondDeferred.resolve();
          await finishSecond.promise;
          await turn.turnAdoptionLifecycle?.onAdopted();
        } else {
          expect(firstComplete).toBe(false);
          turn.turnAdoptionLifecycle?.onDeferred();
          thirdDispatched.resolve();
          await turn.turnAdoptionLifecycle?.onAdopted();
        }
      });
      await h.send(message("first"));
      await firstRunning.promise;
      await h.send(message("second"));
      await secondDeferred.promise;
      await h.send(message("third"));
      await thirdDispatched.promise;
      expect(h.handleMessage.mock.calls.map(([turn]) => turn.event.message.message_id)).toEqual([
        "om-first",
        "om-second",
        "om-third",
      ]);
      expect(firstComplete).toBe(false);
      expect(h.active.size).toBeGreaterThanOrEqual(2);
      finishSecond.resolve();
      finishFirst.resolve();
    });
  });

  it("keeps same-topic preparation FIFO while durable receipt and other topics continue", async () => {
    await withIngress(
      async (h) => {
        const mediaStarted = h.gate();
        const mediaReady = h.gate();
        const finishFirst = h.gate();
        const otherDispatched = h.gate();
        const nextDispatched = h.gate();
        const preparation: string[] = [];
        h.handleMessage.mockImplementation(async (turn) => {
          const id = turn.event.message.message_id;
          preparation.push(id);
          if (id === "om-first") {
            mediaStarted.resolve();
            await mediaReady.promise;
            await turn.turnAdoptionLifecycle?.onAdopted();
            await finishFirst.promise;
          } else {
            await turn.turnAdoptionLifecycle?.onAdopted();
            (id === "om-other" ? otherDispatched : nextDispatched).resolve();
          }
        });
        await h.send(message("first", { sender: "ou-first" }));
        const flushFirst = h.flush("first");
        await mediaStarted.promise;
        // A different sender reserves a distinct batch on the same conversation lane.
        await h.send(message("next", { sender: "ou-next" }));
        const flushNext = h.flush("next");
        await h.send(message("other", { rootId: "om-other-topic" }));
        await h.flush("other");
        await otherDispatched.promise;
        expect(preparation).toEqual(["om-first", "om-other"]);
        mediaReady.resolve();
        await flushFirst;
        await nextDispatched.promise;
        await flushNext;
        expect(preparation).toEqual(["om-first", "om-other", "om-next"]);
        expect(h.active.size).toBeGreaterThanOrEqual(1);
        finishFirst.resolve();
      },
      { buffered: true },
    );
  });

  it.each(["group", "topic_group"] as const)(
    "allows independent %s topics while the first topic is not adopted",
    async (chatType) => {
      await withIngress(
        async (h) => {
          const preparing = h.gate();
          const ready = h.gate();
          const independent = h.gate();
          h.handleMessage.mockImplementation(async (turn) => {
            if (turn.event.message.message_id === "om-first") {
              preparing.resolve();
              await ready.promise;
            } else {
              independent.resolve();
            }
            await turn.turnAdoptionLifecycle?.onAdopted();
          });
          await h.send(message("first", { chatType, rootId: "om-shared", threadId: "omt-a" }));
          const flushing = h.flush("first");
          await preparing.promise;
          await h.send(
            message("other", {
              chatType,
              // Native topics must prefer thread_id despite a common root_id.
              rootId: chatType === "topic_group" ? "om-shared" : "om-other",
              threadId: "omt-b",
            }),
          );
          await h.flush("other");
          await independent.promise;
          expect(h.handleMessage).toHaveBeenCalledTimes(2);
          ready.resolve();
          await flushing;
        },
        { buffered: true },
      );
    },
  );

  it("deduplicates both repeated event_id and a fresh event_id carrying the same message_id", async () => {
    await withIngress(async (h) => {
      const active = h.gate();
      const finish = h.gate();
      h.handleMessage.mockImplementation(async (turn) => {
        await turn.turnAdoptionLifecycle?.onAdopted();
        active.resolve();
        await finish.promise;
      });
      const original = message("original");
      await h.send(original);
      await active.promise;
      expect(await h.ingress.invokeWebhook(original)).toMatchObject({ kind: "durable" });
      const twinCompleted = observeChannelIngressQueueWrite(h.queue, "complete", "twin");
      await h.send(message("twin", { messageId: original.message.message_id }));
      await twinCompleted;
      expect(h.handleMessage).toHaveBeenCalledTimes(1);
      expect(h.active.size).toBeGreaterThanOrEqual(1);
      finish.resolve();
    });
  });

  it("does not release an immediate file message before its attachment preparation admits", async () => {
    await withIngress(async (h) => {
      const preparing = h.gate();
      const ready = h.gate();
      const second = h.gate();
      h.handleMessage.mockImplementation(async (turn) => {
        if (turn.event.message.message_type === "file") {
          expect(turn.event.message.content).toContain("file-first");
          preparing.resolve();
          await ready.promise;
        } else {
          second.resolve();
        }
        await turn.turnAdoptionLifecycle?.onAdopted();
      });
      const firstReceipt = h.send(message("first", { messageType: "file" }));
      await preparing.promise;
      expect(await h.ingress.invokeWebhook(message("second"))).toMatchObject({ kind: "durable" });
      const pending = await h.queue.listPending({ limit: "all" });
      expect(pending.map((entry) => entry.id)).toContain("second");
      expect(h.handleMessage).toHaveBeenCalledTimes(1);
      ready.resolve();
      await firstReceipt;
      await second.promise;
    });
  });

  it("abandons a failed preparation without losing the next same-topic input", async () => {
    await withIngress(
      async (h) => {
        const preparing = h.gate();
        const failPreparation = h.gate();
        const nextDispatched = h.gate();
        h.handleMessage.mockImplementation(async (turn) => {
          if (turn.event.message.message_id === "om-first") {
            preparing.resolve();
            await failPreparation.promise;
            throw new Error("attachment preparation failed");
          }
          await turn.turnAdoptionLifecycle?.onAdopted();
          nextDispatched.resolve();
        });
        await h.send(message("first"));
        const flushFirst = h.flush("first");
        await preparing.promise;
        await h.send(message("next"));
        const flushNext = h.flush("next");
        const firstReleased = observeChannelIngressQueueWrite(h.queue, "release", "first");
        failPreparation.resolve();
        await firstReleased;
        await flushFirst;
        await flushNext;
        await nextDispatched.promise;
        await Promise.allSettled(h.tracked);
        expect(h.handleMessage.mock.calls.map(([turn]) => turn.event.message.message_id)).toEqual([
          "om-first",
          "om-next",
        ]);
        expect(await hasProcessedFeishuMessage("om-first", "default")).toBe(false);
        expect(await hasProcessedFeishuMessage("om-next", "default")).toBe(true);
        expect(await h.queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({ id: "first", attempts: 1, lastError: "turn-abandoned" }),
        ]);
        expect(h.error).toHaveBeenCalledWith(
          expect.stringContaining("attachment preparation failed"),
        );
      },
      { buffered: true },
    );
  });

  it("keeps adopted full-run completion drainable after freeing the ingress lane", async () => {
    await withIngress(async (h) => {
      const running = h.gate();
      const finish = h.gate();
      const next = h.gate();
      let firstCompleted = false;
      h.handleMessage.mockImplementation(async (turn) => {
        await turn.turnAdoptionLifecycle?.onAdopted();
        if (turn.event.message.message_id === "om-first") {
          running.resolve();
          await finish.promise;
          firstCompleted = true;
        } else {
          next.resolve();
        }
      });
      await h.send(message("first"));
      await running.promise;
      let drained = false;
      const shutdownDrain = h.debouncer.drain().then(() => {
        drained = true;
      });
      await h.send(message("next"));
      await next.promise;
      expect(firstCompleted).toBe(false);
      expect(drained).toBe(false);
      expect(h.active.size).toBeGreaterThanOrEqual(1);
      finish.resolve();
      await shutdownDrain;
      await Promise.all(h.tracked);
      expect(firstCompleted).toBe(true);
      expect(drained).toBe(true);
      expect(h.active.size).toBe(0);
    });
  });

  it("keeps a cross-sender immediate attachment behind an earlier buffered text admission", async () => {
    await withIngress(
      async (h) => {
        const textPreparing = h.gate();
        const textReady = h.gate();
        const fileDispatched = h.gate();
        const order: string[] = [];
        h.handleMessage.mockImplementation(async (turn) => {
          order.push(turn.event.message.message_id);
          if (turn.event.message.message_type === "text") {
            expect(turn.event.sender.sender_id.open_id).toBe("ou-text");
            expect(turn.preparedContent).toBeUndefined();
            textPreparing.resolve();
            await textReady.promise;
          } else {
            expect(turn.event.sender.sender_id.open_id).toBe("ou-file");
            fileDispatched.resolve();
          }
          await turn.turnAdoptionLifecycle?.onAdopted();
        });
        await h.send(message("text", { sender: "ou-text" }));
        const fileReceipt = h.send(message("file", { sender: "ou-file", messageType: "file" }));
        await textPreparing.promise;
        expect(order).toEqual(["om-text"]);
        expect(h.key("text")).toBe(h.key("file"));
        textReady.resolve();
        await fileReceipt;
        await fileDispatched.promise;
        expect(order).toEqual(["om-text", "om-file"]);
      },
      { buffered: true },
    );
  });

  it("releases abandoned preparation for later input while retaining the cancelled full handler", async () => {
    await withIngress(
      async (h) => {
        const preparing = h.gate();
        const finishPreparation = h.gate();
        const nextDispatched = h.gate();
        let lateDispatch = false;
        h.handleMessage.mockImplementation(async (turn) => {
          if (turn.event.message.message_id === "om-first") {
            preparing.resolve();
            await finishPreparation.promise;
            // The real bot must make the same final cancellation check before core dispatch.
            turn.turnAdoptionLifecycle?.abortSignal.throwIfAborted();
            lateDispatch = true;
          }
          await turn.turnAdoptionLifecycle?.onAdopted();
          nextDispatched.resolve();
        });
        await h.send(message("first"));
        const firstFlush = h.flush("first");
        await preparing.promise;
        await h.send(message("next"));
        const nextFlush = h.flush("next");
        const abandoned = observeChannelIngressQueueWrite(h.queue, "release", "first");
        h.abort("first");
        await abandoned;
        await firstFlush;
        await nextFlush;
        await nextDispatched.promise;
        expect(await hasProcessedFeishuMessage("om-first", "default")).toBe(false);
        expect(h.active.size).toBeGreaterThanOrEqual(1);
        expect(lateDispatch).toBe(false);
        finishPreparation.resolve();
        await Promise.allSettled(h.tracked);
        expect(lateDispatch).toBe(false);
      },
      { buffered: true },
    );
  });

  it("hydrates a native topic starter before reserving the same lane as a later native reply", async () => {
    await withIngress(
      async (h) => {
        const fetching = h.gate();
        const fetched = h.gate();
        const firstPreparing = h.gate();
        const firstReady = h.gate();
        const secondDispatched = h.gate();
        h.fetchMessage.mockImplementation(async ({ messageId }) => {
          fetching.resolve();
          await fetched.promise;
          return {
            messageId,
            chatId: "oc-chat",
            threadId: "omt-native",
            content: "first",
            contentType: "text",
          };
        });
        h.handleMessage.mockImplementation(async (turn) => {
          expect(turn.event.message.thread_id).toBe("omt-native");
          if (turn.event.message.message_id === "om-first") {
            firstPreparing.resolve();
            await firstReady.promise;
          } else {
            secondDispatched.resolve();
          }
          await turn.turnAdoptionLifecycle?.onAdopted();
        });
        const starter = h.send(
          message("first", { chatType: "topic_group", rootId: "om-first", sender: "ou-first" }),
        );
        await fetching.promise;
        const reply = h.send(
          message("reply", {
            chatType: "topic_group",
            rootId: "om-reply",
            threadId: "omt-native",
            sender: "ou-second",
          }),
        );
        await h.receiving("reply");
        expect(h.handleMessage).not.toHaveBeenCalled();
        expect(h.key("reply")).toBeUndefined();
        fetched.resolve();
        await starter;
        await reply;
        await firstPreparing.promise;
        expect(h.key("first")).toBe(h.key("reply"));
        expect(h.handleMessage).toHaveBeenCalledTimes(1);
        const flushReply = h.flush("reply");
        firstReady.resolve();
        await flushReply;
        await secondDispatched.promise;
        expect(h.handleMessage.mock.calls.map(([turn]) => turn.event.message.message_id)).toEqual([
          "om-first",
          "om-reply",
        ]);
        expect(h.fetchMessage).toHaveBeenCalledOnce();
      },
      { buffered: true },
    );
  });

  it("reserves native topic receipt order before a delayed logical dedupe claim", async () => {
    await withIngress(
      async (h) => {
        const claiming = h.gate();
        const allowClaim = h.gate();
        const firstPreparing = h.gate();
        const firstReady = h.gate();
        const replyDispatched = h.gate();
        const claimMessage = dedup.claimUnprocessedFeishuMessage;
        const claim = vi
          .spyOn(dedup, "claimUnprocessedFeishuMessage")
          .mockImplementation(async (params) => {
            if (params.messageId === "om-first") {
              claiming.resolve();
              await allowClaim.promise;
            }
            return claimMessage(params);
          });
        h.fetchMessage.mockImplementation(async ({ messageId }) => ({
          messageId,
          chatId: "oc-chat",
          threadId: "omt-native",
          content: "first",
          contentType: "text",
        }));
        h.handleMessage.mockImplementation(async (turn) => {
          expect(turn.event.message.thread_id).toBe("omt-native");
          if (turn.event.message.message_id === "om-first") {
            firstPreparing.resolve();
            await firstReady.promise;
          } else {
            replyDispatched.resolve();
          }
          await turn.turnAdoptionLifecycle?.onAdopted();
        });
        try {
          const starter = h.send(
            message("first", { chatType: "topic_group", rootId: "om-first", sender: "ou-first" }),
          );
          await claiming.promise;
          const reply = h.send(
            message("reply", {
              chatType: "topic_group",
              rootId: "om-reply",
              threadId: "omt-native",
              sender: "ou-reply",
            }),
          );
          await h.receiving("reply");
          expect(claim).toHaveBeenCalledOnce();
          expect(h.fetchMessage).not.toHaveBeenCalled();
          expect(h.key("reply")).toBeUndefined();
          allowClaim.resolve();
          await starter;
          await reply;
          await firstPreparing.promise;
          expect(claim.mock.calls.map(([params]) => params.messageId)).toEqual([
            "om-first",
            "om-reply",
          ]);
          expect(h.key("first")).toBe(h.key("reply"));
          expect(h.handleMessage).toHaveBeenCalledTimes(1);
          const flushReply = h.flush("reply");
          firstReady.resolve();
          await flushReply;
          await replyDispatched.promise;
          expect(h.handleMessage.mock.calls.map(([turn]) => turn.event.message.message_id)).toEqual(
            ["om-first", "om-reply"],
          );
        } finally {
          allowClaim.resolve();
          firstReady.resolve();
          claim.mockRestore();
        }
      },
      { buffered: true },
    );
  });

  it("releases cancelled receipt order before a delayed claim completes without consuming that claim", async () => {
    await withIngress(async (h) => {
      const claiming = h.gate();
      const allowClaim = h.gate();
      const released = h.gate();
      const independentDispatched = h.gate();
      const lateClaim: dedup.FeishuMessageProcessingClaim = {
        keys: ["om-first"],
        commit: vi.fn(async () => true),
        release: vi.fn(() => released.resolve()),
      };
      const claimMessage = dedup.claimUnprocessedFeishuMessage;
      const claim = vi
        .spyOn(dedup, "claimUnprocessedFeishuMessage")
        .mockImplementation(async (params) => {
          if (params.messageId === "om-first") {
            claiming.resolve();
            await allowClaim.promise;
            return { kind: "claimed", handle: lateClaim };
          }
          return claimMessage(params);
        });
      h.handleMessage.mockImplementation(async (turn) => {
        expect(turn.event.message.message_id).toBe("om-independent");
        await turn.turnAdoptionLifecycle?.onAdopted();
        independentDispatched.resolve();
      });
      try {
        const first = h.send(message("first"));
        await claiming.promise;
        const abandoned = observeChannelIngressQueueWrite(h.queue, "release", "first");
        h.abort("first");
        await abandoned;
        await first;

        await h.send(message("independent", { rootId: "om-independent-topic" }));
        await independentDispatched.promise;
        expect(claim.mock.calls.map(([params]) => params.messageId)).toEqual([
          "om-first",
          "om-independent",
        ]);
        expect(lateClaim.release).not.toHaveBeenCalled();
        expect(lateClaim.commit).not.toHaveBeenCalled();
        expect(h.handleMessage).toHaveBeenCalledOnce();

        allowClaim.resolve();
        await released.promise;
        expect(lateClaim.release).toHaveBeenCalledOnce();
        expect(lateClaim.commit).not.toHaveBeenCalled();
        expect(h.handleMessage).toHaveBeenCalledOnce();
        expect(await hasProcessedFeishuMessage("om-first", "default")).toBe(false);
      } finally {
        allowClaim.resolve();
        await Promise.allSettled(h.tracked);
        claim.mockRestore();
      }
    });
  });
});
