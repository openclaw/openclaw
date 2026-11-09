import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { parseFeishuMessageEvent } from "./bot.js";
import { createFeishuTestEvent } from "./bot.test-support.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuDurableIngress, type FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(
  eventId: string,
  messageId: string,
  text: string,
): FeishuMessageEvent & { event_id: string } {
  return {
    ...createFeishuTestEvent({
      messageId,
      senderOpenId: "ou-user",
      senderType: "user",
      chatId: "oc-chat",
      text,
      message: { create_time: "1710000000000" },
    }),
    event_id: eventId,
  };
}

function createLifecycle() {
  const controller = new AbortController();
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
      await lifecycle.onBeforeAbandon?.();
      await calls.abandoned();
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feishu topic durable admission", () => {
  it("abandons durable ownership when deferred topic enqueue rejects", async () => {
    const transport = createLifecycle();
    const logicalClaim = createClaim("topic-enqueue-error");
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockResolvedValue({
      kind: "claimed",
      handle: logicalClaim,
    });
    const handleMessage = vi.fn(async () => {});
    const handler = createFeishuMessageReceiveHandler({
      cfg: { channels: { feishu: { groupSessionScope: "group_topic" } } },
      channelRuntime: createPluginRuntimeMock({
        channel: {
          commands: { isControlCommandMessage },
          debounce: {
            resolveInboundDebounceMs: () => 0,
            createInboundDebouncer: (options) => ({
              ...createInboundDebouncer(options),
              enqueue: async () => {
                throw new Error("enqueue failed");
              },
            }),
          },
        },
      }).channel,
      accountId: "default",
      chatHistories: new Map(),
      runtime: { ...createNonExitingRuntimeEnv(), log: vi.fn(), error: vi.fn() },
      resolveSequentialKey: getFeishuSequentialKey,
      resolveDebounceText: ({ event }) => parseFeishuMessageEvent(event).content,
      hasProcessedMessage: async () => false,
      resolveIngressLifecycle: () => transport.lifecycle,
      handleMessage,
    });
    const event = createTextEvent("evt-enqueue-error", "om-enqueue-error", "hello");
    event.message.chat_type = "topic_group";
    event.message.thread_id = "omt-a";
    await expect(handler(event)).resolves.toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(transport.calls.abandoned).toHaveBeenCalledOnce());
    expect(logicalClaim.release).toHaveBeenCalled();
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "orders the durable backlog before a fallback (fallback=%s)",
    async (fallback) => {
      await withOpenClawTestState({ label: "feishu-topic-backlog" }, async ({ stateDir }) => {
        type Queue = NonNullable<Parameters<typeof createFeishuDurableIngress>[0]["queue"]>;
        const queue = createChannelIngressQueueForTests<Parameters<Queue["enqueue"]>[1]>({
          channelId: "feishu",
          accountId: "default",
          stateDir,
        });
        const active = createDeferred<void>();
        const started: string[] = [];
        const cfg: ClawdbotConfig = { channels: { feishu: { groupSessionScope: "group_topic" } } };
        vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockImplementation(
          async ({ messageId }) => ({
            kind: "claimed",
            handle: createClaim(messageId ?? "backlog"),
          }),
        );
        const handler = createFeishuMessageReceiveHandler({
          cfg,
          channelRuntime: createPluginRuntimeMock({
            channel: {
              commands: { isControlCommandMessage },
              debounce: { resolveInboundDebounceMs: () => 0, createInboundDebouncer },
            },
          }).channel,
          accountId: "default",
          chatHistories: new Map(),
          runtime: { ...createNonExitingRuntimeEnv(), log: vi.fn(), error: vi.fn() },
          resolveSequentialKey: getFeishuSequentialKey,
          resolveDebounceText: ({ event }) => parseFeishuMessageEvent(event).content,
          hasProcessedMessage: async () => false,
          resolveIngressLifecycle: (data) => ingress.resolveLifecycle(data),
          handleMessage: async ({ event, turnAdoptionLifecycle }) => {
            await turnAdoptionLifecycle?.onAdopted();
            const text = parseFeishuMessageEvent(event).content;
            started.push(text);
            if (text === "a1") {
              await active.promise;
            }
          },
        });
        const ingressOptions = {
          accountId: "default",
          cfg,
          queue,
          dispatcher: { invoke: async (data: unknown) => handler(data) },
          runtime: { log: vi.fn(), error: vi.fn() },
          pollIntervalMs: 500,
        };
        const ingress = createFeishuDurableIngress(ingressOptions);
        const receive = async (text: string, thread?: string) => {
          const event = createTextEvent(`evt-backlog-${text}`, `om-backlog-${text}`, text);
          event.message.chat_type = "topic_group";
          event.message.thread_id = thread;
          await ingress.invoke(
            { ...event, event_type: "im.message.receive_v1" },
            { needCheck: false },
          );
        };
        ingress.start();
        try {
          await receive("a1", "omt-a");
          await vi.waitFor(() => expect(started).toEqual(["a1"]));
          await receive("a2", "omt-a");
          await receive("a3", "omt-a");
          if (fallback) {
            await receive("fallback");
          }
          await receive("b", "omt-b");
          if (fallback) {
            await vi.waitFor(async () =>
              expect((await queue.listClaims()).map((c) => c.id)).toContain("evt-backlog-fallback"),
            );
            expect(started).toEqual(["a1"]);
          } else {
            await vi.waitFor(() => expect(started).toEqual(["a1", "b"]));
          }
          active.resolve();
          await vi.waitFor(() =>
            expect(started).toEqual(
              fallback ? ["a1", "a2", "a3", "fallback", "b"] : ["a1", "b", "a2", "a3"],
            ),
          );
          await ingress.waitForIdle();
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
        } finally {
          active.resolve();
          await ingress.stop();
        }
      });
    },
  );
});
