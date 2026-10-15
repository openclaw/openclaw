// Exercise the receive handler's real debounce and per-chat queue composition.
// Agent execution and replay persistence remain fixed external I/O fixtures.
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

function createTextEvent(messageId: string): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou-user" }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc-chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: messageId }),
    },
  };
}

function createQueuedMessages(
  timeoutSeconds?: number,
  options?: { cfg?: ClawdbotConfig; accountId?: string; blockFollowUp?: boolean },
) {
  const cfg: ClawdbotConfig =
    options?.cfg ??
    (timeoutSeconds === undefined ? {} : { agents: { defaults: { timeoutSeconds } } });
  const firstGate = createDeferred();
  const firstFinished = createDeferred();
  const followUpGate = options?.blockFollowUp ? createDeferred() : undefined;
  const followUpFinished = createDeferred();
  const order: string[] = [];
  const log = vi.fn();
  const error = vi.fn();
  let drain = async () => {};
  const createDebouncer: typeof createInboundDebouncer = (debounceOptions) => {
    const debouncer = createInboundDebouncer(debounceOptions);
    drain = debouncer.drain;
    return debouncer;
  };
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: { createInboundDebouncer: createDebouncer, resolveInboundDebounceMs },
  } as unknown as PluginRuntime["channel"];
  const handler = createFeishuMessageReceiveHandler({
    cfg,
    channelRuntime,
    accountId: options?.accountId ?? "default",
    runtime: { log, error, exit: () => {} },
    chatHistories: new Map(),
    handleMessage: async ({ event }) => {
      const messageId = event.message.message_id;
      order.push(`${messageId}:start`);
      if (messageId === "first") {
        await firstGate.promise;
      } else if (messageId === "follow-up") {
        await followUpGate?.promise;
      }
      order.push(`${messageId}:reply`);
      if (messageId === "first") {
        firstFinished.resolve();
      } else if (messageId === "follow-up") {
        followUpFinished.resolve();
      }
    },
    resolveDebounceText: ({ event }) => event.message.content,
    hasProcessedMessage: async () => false,
  });
  const tasks: ReturnType<typeof handler>[] = [];
  const enqueue = (messageId: string) => {
    const task = handler(createTextEvent(messageId));
    tasks.push(task);
    return task;
  };
  void enqueue("first");
  const followUp = enqueue("follow-up");
  const finish = async () => {
    firstGate.resolve();
    followUpGate?.resolve();
    await Promise.all([...tasks, firstFinished.promise, followUpFinished.promise]);
    await drain();
  };
  return { order, log, error, followUp, enqueue, finish };
}

describe("Feishu message receive task timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 13));
    vi.stubEnv("OPENCLAW_FEISHU_HTTP_TIMEOUT_MS", undefined);
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockImplementation(async ({ messageId }) =>
      messageId
        ? {
            kind: "claimed",
            handle: { keys: [messageId], commit: async () => true, release: () => {} },
          }
        : { kind: "invalid" },
    );
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "a configured one-hour turn",
      configJson: '{"agents":{"defaults":{"timeoutSeconds":3600}}}',
      remainingMs: 3_314_999,
    },
    {
      name: "existing canonical settings",
      configJson:
        '{"agents":{"defaults":{"timeoutSeconds":600}},"channels":{"feishu":{' +
        '"appId":"cli_fixture","appSecret":"synthetic-secret","renderMode":"card",' +
        '"streaming":{"mode":"partial","block":{"enabled":false}},"httpTimeoutMs":30000}}}',
      remainingMs: 314_999,
    },
  ])(
    "keeps $name ahead of later same-chat messages through final delivery",
    async ({ configJson, remainingMs }) => {
      const cfg = JSON.parse(configJson) as ClawdbotConfig;
      if (cfg.channels?.feishu) {
        FeishuConfigSchema.parse(cfg.channels.feishu);
      }
      // Validate the saved channel settings without replacing the caller's config.
      expect(JSON.stringify(cfg)).toBe(configJson);
      const queue = createQueuedMessages(undefined, { cfg });
      try {
        await vi.advanceTimersByTimeAsync(300_001);
        expect(queue.order).toEqual(["first:start"]);
        // Final delivery may finish after the agent's own execution deadline.
        await vi.advanceTimersByTimeAsync(remainingMs);
        expect(queue.order).toEqual(["first:start"]);
        expect(queue.log).not.toHaveBeenCalled();

        await queue.finish();

        expect(queue.order).toEqual([
          "first:start",
          "first:reply",
          "follow-up:start",
          "follow-up:reply",
        ]);
        expect(queue.error).not.toHaveBeenCalled();
        expect(JSON.stringify(cfg)).toBe(configJson);
      } finally {
        await queue.finish();
      }
    },
  );

  it("releases a stuck configured turn after its one-hour budget and delivery grace", async () => {
    const queue = createQueuedMessages(3600);
    try {
      await vi.advanceTimersByTimeAsync(3_629_999);
      expect(queue.order).toEqual(["first:start"]);

      await vi.advanceTimersByTimeAsync(1);
      await queue.followUp;

      expect(queue.order).toEqual(["first:start", "follow-up:start", "follow-up:reply"]);
      expect(queue.log).toHaveBeenCalledWith(
        expect.stringContaining("per-chat task exceeded 3630000ms cap"),
      );
      expect(queue.error).not.toHaveBeenCalled();
    } finally {
      await queue.finish();
    }
  });

  it("refreshes a queued turn's budget at startup while retaining the running turn's deadline", async () => {
    const cfg: ClawdbotConfig = {
      channels: { feishu: { accounts: { work: { httpTimeoutMs: 30_000 } } } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const queue = createQueuedMessages(undefined, { cfg, accountId: "work", blockFollowUp: true });
    const later = queue.enqueue("later");
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      const updated: ClawdbotConfig = {
        agents: { defaults: { timeoutSeconds: 3600 } },
        channels: {
          feishu: { httpTimeoutMs: 30_000, accounts: { work: { httpTimeoutMs: 120_000 } } },
        },
      };
      setRuntimeConfigSnapshot(updated, updated);

      await vi.advanceTimersByTimeAsync(298_999);
      expect(queue.order).toEqual(["first:start"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(queue.order).toEqual(["first:start", "follow-up:start"]);
      expect(queue.log).toHaveBeenCalledWith(
        expect.stringContaining("per-chat task exceeded 300000ms cap"),
      );

      await vi.advanceTimersByTimeAsync(3_719_999);
      expect(queue.order).toEqual(["first:start", "follow-up:start"]);
      await vi.advanceTimersByTimeAsync(1);
      await later;
      expect(queue.order).toEqual(["first:start", "follow-up:start", "later:start", "later:reply"]);
      expect(queue.log).toHaveBeenCalledWith(
        expect.stringContaining("per-chat task exceeded 3720000ms cap"),
      );
      expect(queue.error).not.toHaveBeenCalled();
    } finally {
      await queue.finish();
    }
  });

  it.each([
    { name: "channel timeout", accountId: "default", feishu: { httpTimeoutMs: 120_000 } },
    {
      name: "account override",
      accountId: "work",
      feishu: { httpTimeoutMs: 30_000, accounts: { work: { httpTimeoutMs: 120_000 } } },
    },
  ])("reserves final-delivery grace for the configured $name", async ({ accountId, feishu }) => {
    const cfg: ClawdbotConfig = {
      agents: { defaults: { timeoutSeconds: 3600 } },
      channels: { feishu },
    };
    const queue = createQueuedMessages(undefined, { cfg, accountId });
    try {
      await vi.advanceTimersByTimeAsync(3_719_999);
      expect(queue.order).toEqual(["first:start"]);
      expect(queue.log).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await queue.followUp;
      expect(queue.order).toEqual(["first:start", "follow-up:start", "follow-up:reply"]);
      expect(queue.log).toHaveBeenCalledWith(
        expect.stringContaining("per-chat task exceeded 3720000ms cap"),
      );
      expect(queue.error).not.toHaveBeenCalled();
    } finally {
      await queue.finish();
    }
  });

  it.each([undefined, 60])(
    "retains the five-minute watchdog when the agent timeout is %s",
    async (timeoutSeconds) => {
      const queue = createQueuedMessages(timeoutSeconds);
      try {
        await vi.advanceTimersByTimeAsync(299_999);
        expect(queue.order).toEqual(["first:start"]);

        await vi.advanceTimersByTimeAsync(1);
        await queue.followUp;

        expect(queue.order).toEqual(["first:start", "follow-up:start", "follow-up:reply"]);
        expect(queue.log).toHaveBeenCalledWith(
          expect.stringContaining("per-chat task exceeded 300000ms cap"),
        );
        expect(queue.error).not.toHaveBeenCalled();
      } finally {
        await queue.finish();
      }
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "uses the runtime's bounded unlimited deadline for agent timeout %s",
    async (timeoutSeconds) => {
      const queue = createQueuedMessages(timeoutSeconds);
      try {
        await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS - 1);
        expect(queue.order).toEqual(["first:start"]);
        expect(queue.log).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await queue.followUp;

        expect(queue.order).toEqual(["first:start", "follow-up:start", "follow-up:reply"]);
        expect(queue.log).toHaveBeenCalledWith(
          expect.stringContaining(`per-chat task exceeded ${MAX_TIMER_TIMEOUT_MS}ms cap`),
        );
        expect(queue.error).not.toHaveBeenCalled();
      } finally {
        await queue.finish();
      }
    },
  );
});
