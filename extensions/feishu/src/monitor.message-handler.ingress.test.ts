// Feishu ingress tests cover debounce ownership and constituent claim settlement.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuDurableIngress, type FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];
type DebounceEntry = Parameters<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>[0][number];
type DebounceFlush = ReturnType<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>;
type DebounceFlushFactory = typeof createTestInboundDebounceFlush;

function createTextEvent(
  eventId: string,
  messageId: string,
  text: string,
): FeishuMessageEvent & { event_id: string } {
  return {
    event_id: eventId,
    sender: {
      sender_id: { open_id: "ou-user" },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      chat_id: "oc-chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: "1710000000000",
    },
  };
}

function createLifecycle() {
  const controller = new AbortController();
  const abandonHandlers = new Set<() => void | Promise<void>>();
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: controller.signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: async () => {
      await Promise.all([...abandonHandlers].map(async (handler) => await handler()));
      await calls.abandoned();
    },
    registerAbandonHandler: (handler) => {
      abandonHandlers.add(handler);
      return () => abandonHandlers.delete(handler);
    },
  };
  return { calls, controller, lifecycle };
}

function createClaim(name: string): dedup.FeishuMessageProcessingClaim {
  return {
    keys: [name],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

function createHarness(params: {
  lifecycles: ReadonlyMap<string, FeishuIngressLifecycle>;
  claims: readonly dedup.FeishuMessageProcessingClaim[];
  adoptTurn: boolean;
}) {
  let onFlush:
    | ((entries: DebounceEntry[], createFlush: DebounceFlushFactory) => DebounceFlush)
    | undefined;
  let onError: ((err: unknown, entries: DebounceEntry[]) => void) | undefined;
  const entries: DebounceEntry[] = [];
  const runtimeError = vi.fn();
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: {
      resolveInboundDebounceMs: () => 25,
      createInboundDebouncer: vi.fn(
        (options: {
          onFlush: (entries: DebounceEntry[], createFlush: DebounceFlushFactory) => DebounceFlush;
          onError: (err: unknown, entries: DebounceEntry[]) => void;
        }) => {
          onFlush = options.onFlush;
          onError = options.onError;
          return {
            enqueue: async (entry: DebounceEntry) => {
              entries.push(entry);
            },
            flushKey: async () => {},
            cancelKey: () => false,
            drain: async () => {},
          };
        },
      ),
    },
  } as unknown as PluginRuntime["channel"];
  const handleMessage = vi.fn(async (turn: HandleMessageParams) => {
    if (params.adoptTurn) {
      turn.turnAdoptionLifecycle?.onAdoptionFinalizing();
      await turn.turnAdoptionLifecycle?.onAdopted();
    }
  });
  const claim = vi.spyOn(dedup, "claimUnprocessedFeishuMessage");
  for (const handle of params.claims) {
    claim.mockResolvedValueOnce({ kind: "claimed", handle });
  }
  const hasProcessedMessage = vi.fn(async (_messageId: string | undefined | null) => false);
  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    runtime: { ...createNonExitingRuntimeEnv(), error: runtimeError } satisfies RuntimeEnv,
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: ({ event }) =>
      (JSON.parse(event.message.content) as { text: string }).text,
    hasProcessedMessage,
    getBotOpenId: () => "ou-bot",
    resolveIngressLifecycle: (data) => {
      const eventId = (data as { event_id?: string }).event_id;
      return eventId ? params.lifecycles.get(eventId) : undefined;
    },
  });
  return {
    claim,
    entries,
    handler,
    handleMessage,
    hasProcessedMessage,
    flush: async () => {
      if (!onFlush) {
        throw new Error("debouncer flush callback missing");
      }
      await onFlush(entries.splice(0), createTestInboundDebounceFlush).completion;
    },
    failFlush: (err: unknown) => {
      if (!onError) {
        throw new Error("debouncer error callback missing");
      }
      onError(err, entries);
    },
    runtimeError,
  };
}

function createTurn(name: string, options: { adoptTurn?: boolean; noClaim?: boolean } = {}) {
  const transport = createLifecycle();
  const logicalClaim = createClaim(name);
  const event = createTextEvent(`evt-${name}`, `om-${name}`, "queued");
  const harness = createHarness({
    lifecycles: new Map([[event.event_id, transport.lifecycle]]),
    claims: options.noClaim ? [] : [logicalClaim],
    adoptTurn: options.adoptTurn ?? true,
  });
  return { transport, logicalClaim, event, harness };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feishu durable ingress debounce lifecycle", () => {
  it("releases a claim acquired after ingress abandonment instead of enqueueing it", async () => {
    const transport = createLifecycle();
    const logicalClaim = createClaim("delayed-admission");
    const pending =
      createDeferred<Awaited<ReturnType<typeof dedup.claimUnprocessedFeishuMessage>>>();
    const harness = createHarness({
      lifecycles: new Map([["evt-delayed", transport.lifecycle]]),
      claims: [],
      adoptTurn: true,
    });
    harness.claim.mockReturnValueOnce(pending.promise);
    const handling = harness.handler(createTextEvent("evt-delayed", "om-delayed", "hello"));
    transport.controller.abort();
    await transport.lifecycle.onAbandoned();
    pending.resolve({ kind: "claimed", handle: logicalClaim });

    await expect(handling).resolves.toMatchObject({ kind: "failed-retryable" });
    expect(logicalClaim.release).toHaveBeenCalledOnce();
    expect(logicalClaim.commit).not.toHaveBeenCalled();
    expect(harness.entries).toEqual([]);
    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(transport.calls.adopted).not.toHaveBeenCalled();
  });

  it("accepts an empty private message body without losing bot mentions or ingress adoption", async () => {
    const { transport, logicalClaim, event, harness } = createTurn("empty-group-mention");

    event.message.chat_type = "private";
    event.message.content = "";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou-bot" },
        name: "OpenClaw",
      },
    ];

    await expect(harness.handler(event)).resolves.toEqual({ kind: "deferred" });
    await harness.flush();

    expect(harness.handleMessage).toHaveBeenCalledOnce();
    expect(harness.handleMessage.mock.calls[0]?.[0].event.message).toEqual(event.message);
    expect(logicalClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
    expect(harness.runtimeError).not.toHaveBeenCalled();
  });

  it("rejects a non-string chat type with a valid body before claims or dispatch", async () => {
    const { transport, event, harness } = createTurn("invalid-chat-type", { noClaim: true });

    Reflect.set(event.message, "chat_type", 42);

    await expect(harness.handler(event)).rejects.toThrow(
      "Feishu durable message event payload is malformed.",
    );

    expect(harness.claim).not.toHaveBeenCalled();
    expect(harness.entries).toEqual([]);
    expect(harness.handleMessage).not.toHaveBeenCalled();
    expect(transport.calls.adopted).not.toHaveBeenCalled();
  });

  it("adopts every constituent while dispatching the latest fresh message", async () => {
    const first = createLifecycle();
    const second = createLifecycle();
    const firstClaim = createClaim("first");
    const secondClaim = createClaim("second");
    const events = [
      createTextEvent("evt-a", "om-a", "alpha"),
      createTextEvent("evt-b", "om-b", "beta"),
    ];
    const harness = createHarness({
      lifecycles: new Map([
        ["evt-a", first.lifecycle],
        ["evt-b", second.lifecycle],
      ]),
      claims: [firstClaim, secondClaim],
      adoptTurn: true,
    });
    for (const event of events) {
      await expect(harness.handler(event)).resolves.toEqual({ kind: "deferred" });
    }
    const keys = harness.claim.mock.calls.map(([params]) => params.messageId);
    harness.hasProcessedMessage.mockImplementation(async (key) => key === keys[1]);
    await harness.flush();

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: events[0],
        messageDedupeKey: keys[0],
        preparedContent: "alpha",
      }),
    );
    for (const claim of [firstClaim, secondClaim]) {
      expect(claim.commit).toHaveBeenCalledOnce();
    }
    for (const transport of [first, second]) {
      expect(transport.calls.finalizing).toHaveBeenCalledOnce();
      expect(transport.calls.adopted).toHaveBeenCalledOnce();
    }
  });

  it("releases a deferred logical claim when the drain abandons before debounce flush", async () => {
    const { transport, logicalClaim, event, harness } = createTurn("abandoned", {
      adoptTurn: false,
    });

    await expect(harness.handler(event)).resolves.toEqual({ kind: "deferred" });
    await transport.lifecycle.onAbandoned();
    await harness.flush();

    expect(logicalClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });

  it("reports rejected durable abandonment after a debounce flush error", async () => {
    const { transport, logicalClaim, event, harness } = createTurn("flush-error", {
      adoptTurn: false,
    });
    transport.calls.abandoned.mockRejectedValueOnce(new Error("state store unavailable"));

    await harness.handler(event);
    harness.failFlush(new Error("flush failed"));

    await vi.waitFor(() => {
      expect(harness.runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("failed to abandon durable ingress after debounce error"),
      );
    });
    expect(logicalClaim.release).toHaveBeenCalled();
  });

  it("does not dispatch a queued turn after its ingress claim aborts", async () => {
    const first = createLifecycle();
    const second = createLifecycle();
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const harness = createHarness({
      lifecycles: new Map([
        ["evt-first", first.lifecycle],
        ["evt-second", second.lifecycle],
      ]),
      claims: [createClaim("first-queued"), createClaim("second-queued")],
      adoptTurn: true,
    });
    harness.handleMessage.mockImplementationOnce(async (turn) => {
      await firstGate;
      turn.turnAdoptionLifecycle?.onAdoptionFinalizing();
      await turn.turnAdoptionLifecycle?.onAdopted();
    });

    await harness.handler(createTextEvent("evt-first", "om-first", "first"));
    const firstFlush = harness.flush();
    await vi.waitFor(() => expect(harness.handleMessage).toHaveBeenCalledTimes(1));
    await harness.handler(createTextEvent("evt-second", "om-second", "second"));
    const secondFlush = harness.flush();
    await Promise.resolve();
    second.controller.abort(new Error("adoption timeout"));
    await second.lifecycle.onAbandoned();
    finishFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(second.calls.adopted).not.toHaveBeenCalled();
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createFeishuDurableIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "feishu",
      accountId: "default",
      stateDir,
    });
    const event = {
      ...createTextEvent("evt-abandon-retry", "om-abandon-retry", "retry me"),
      event_type: "im.message.receive_v1",
    };
    const handleMessage = vi.fn(async () => {
      throw new Error("Feishu dispatch failed before adoption");
    });
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockImplementation(async () => ({
      kind: "claimed",
      handle: createClaim(`retry-${handleMessage.mock.calls.length}`),
    }));

    const createIntegratedIngress = () => {
      const channelRuntime = {
        commands: { isControlCommandMessage: () => false },
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer,
        },
      } as unknown as PluginRuntime["channel"];
      const handler = createFeishuMessageReceiveHandler({
        cfg: {} as ClawdbotConfig,
        channelRuntime,
        accountId: "default",
        runtime: createNonExitingRuntimeEnv(),
        chatHistories: new Map(),
        handleMessage,
        resolveDebounceText: () => "retry me",
        hasProcessedMessage: vi.fn(async () => false),
        getBotOpenId: () => "ou-bot",
        resolveIngressLifecycle: (data) => ingress.resolveLifecycle(data),
      });
      const ingress = createFeishuDurableIngress({
        accountId: "default",
        queue,
        dispatcher: { invoke: async (data: unknown) => await handler(data as never) } as never,
        runtime: { error: vi.fn(), log: vi.fn() },
        pollIntervalMs: 500,
      });
      return ingress;
    };
    const pendingAttempt = async (attempts: number) => {
      let observed: Awaited<ReturnType<typeof queue.listPending>>[number] | undefined;
      await vi.waitFor(async () => {
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toEqual([
          expect.objectContaining({
            id: "evt-abandon-retry",
            attempts,
            lastAttemptAt: expect.any(Number),
            lastError: "turn-abandoned",
          }),
        ]);
        observed = pending[0];
      });
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Feishu retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    try {
      const first = createIntegratedIngress();
      first.start();
      await first.invokeWebhook(event);
      const firstAttempt = await pendingAttempt(1);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      await first.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const blocked = createIntegratedIngress();
      blocked.start();
      await blocked.invokeWebhook(event);
      await vi.advanceTimersByTimeAsync(0);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      await blocked.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const second = createIntegratedIngress();
      second.start();
      await second.invokeWebhook(event);
      const secondAttempt = await pendingAttempt(2);
      expect(handleMessage).toHaveBeenCalledTimes(2);
      await second.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("evt-abandon-retry", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Feishu seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }

      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = createIntegratedIngress();
      threshold.start();
      await threshold.invokeWebhook(event);
      const thresholdAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);
      expect(handleMessage).toHaveBeenCalledTimes(3);
      await threshold.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = createIntegratedIngress();
      beyond.start();
      await beyond.invokeWebhook(event);
      const beyondAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1);
      expect(handleMessage).toHaveBeenCalledTimes(4);
      await beyond.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = createIntegratedIngress();
      blockedRestart.start();
      await blockedRestart.invokeWebhook(event);
      await vi.advanceTimersByTimeAsync(0);
      expect(handleMessage).toHaveBeenCalledTimes(4);
      await blockedRestart.stop();
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
