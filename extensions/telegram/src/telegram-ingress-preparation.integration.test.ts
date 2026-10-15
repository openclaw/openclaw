// Real grammY middleware and SQLite spool. No provider, tenant state, or live transport.
import { Bot } from "grammy";
import {
  createChannelIngressQueueForTests,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { PluginHookBeforeChannelIngressContext } from "openclaw/plugin-sdk/plugin-entry";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

const hooks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    state: {
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
      ) => createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
    },
  }),
}));
vi.mock("openclaw/plugin-sdk/plugin-hook-runtime", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => true, runBeforeChannelIngress: hooks.prepare }),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  readRuntimeConfig: () => ({
    channels: { telegram: { dmPolicy: "allowlist", allowFrom: ["111111"] } },
  }),
}));

const update = () => ({
  update_id: 42,
  message: {
    message_id: 21,
    date: 1_790_000_000,
    from: { id: 111111, is_bot: false, first_name: "Synthetic" },
    chat: { id: 111111, type: "private", first_name: "Synthetic" },
    voice: { file_id: "synthetic-file", file_unique_id: "synthetic-unique", duration: 1 },
  },
});

async function withFixture(
  fn: (fixture: {
    queue: ReturnType<typeof openTelegramIngressQueue>;
    monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
    restart: () => ReturnType<typeof createTelegramTransportIngressMonitor>;
    downloads: ReturnType<typeof vi.fn>;
    bodies: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-preparation-", applyEnv: false },
    async ({ stateDir }) => {
      const downloads = vi.fn();
      const bodies: string[] = [];
      const bot = new Bot("123:synthetic", {
        botInfo: {
          id: 222222,
          is_bot: true,
          first_name: "Synthetic bot",
          username: "synthetic_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      });
      bot.on("message", async (ctx) => {
        // This is the media side-effect boundary; a prepared text has no attachment.
        if (ctx.message.voice) downloads(ctx.message.voice.file_id);
        bodies.push(ctx.message.text ?? "unprepared audio");
      });
      const restart = () =>
        createTelegramTransportIngressMonitor({
          stateDir,
          bot,
          accountId: "default",
          pollIntervalMs: 600_000,
        });
      const queue = openTelegramIngressQueue({ stateDir, accountId: "default" });
      const monitor = restart();
      try {
        await fn({ queue, monitor, restart, downloads, bodies });
      } finally {
        await monitor.stop();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
}

describe("durable Telegram ingress preparation", () => {
  afterEach(() => {
    hooks.prepare.mockReset();
    vi.useRealTimers();
  });

  it("keeps an actual preparation claim alive beyond the native five-minute watchdog without early adoption", async () => {
    vi.useFakeTimers();
    const started = createDeferred();
    const terminal = createDeferred();
    let stopHeartbeat: (() => void) | undefined;
    hooks.prepare.mockImplementation(async (_event, rawContext) => {
      const context = rawContext as PluginHookBeforeChannelIngressContext;
      const timer = setInterval(context.heartbeat, context.heartbeatIntervalMs);
      stopHeartbeat = () => clearInterval(timer);
      started.resolve();
      try {
        await terminal.promise;
        return { text: "Verified transcript", suppressAttachments: true };
      } finally {
        clearInterval(timer);
      }
    });
    await withFixture(async ({ queue, monitor, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await Promise.race([
        started.promise,
        monitor.waitForIdle().then(() => {
          throw new Error("preparation hook was not invoked before native dispatch");
        }),
      ]);
      try {
        await vi.advanceTimersByTimeAsync(360_000);
        expect(downloads).not.toHaveBeenCalled();
        expect((await queue.listClaims()).map((row) => row.id)).toEqual(["0000000000000042"]);
        terminal.resolve();
        await monitor.waitForIdle();
        expect(bodies).toEqual(["Verified transcript"]);
        expect(downloads).not.toHaveBeenCalled();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await monitor.admit(update());
        await monitor.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        stopHeartbeat?.();
        terminal.resolve();
      }
    });
  });

  it("preserves retry facts when native stop cancels preparation, then resumes once without backoff", async () => {
    const started = createDeferred();
    hooks.prepare.mockImplementation((_event, rawContext) => {
      const context = rawContext as PluginHookBeforeChannelIngressContext;
      started.resolve();
      return new Promise((_resolve, reject) => {
        context.abortSignal.addEventListener("abort", () => reject(context.abortSignal.reason), {
          once: true,
        });
      });
    });
    await withFixture(async ({ queue, monitor, restart, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await started.promise;
      expect((await queue.listClaims())[0]?.attempts).toBe(0);
      await monitor.stop();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ attempts: 0, payload: { update: update() } });
      expect(pending[0]?.lastAttemptAt).toBeUndefined();
      expect(pending[0]?.lastError).toBeUndefined();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
      hooks.prepare.mockResolvedValue({ text: "Resumed transcript", suppressAttachments: true });
      const resumed = restart();
      try {
        resumed.start();
        await resumed.waitForIdle();
        expect(bodies).toEqual(["Resumed transcript"]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await resumed.admit(update());
        await resumed.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        await resumed.stop();
      }
    });
  });

  it("retains original attachment identity across failed preparation and restart, then dispatches once", async () => {
    hooks.prepare.mockRejectedValue(new Error("transcript not ready"));
    await withFixture(async ({ queue, monitor, restart, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await monitor.waitForIdle();
      expect(downloads).not.toHaveBeenCalled();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload.update).toMatchObject({
        update_id: 42,
        message: {
          message_id: 21,
          from: { id: 111111 },
          voice: { file_id: "synthetic-file" },
        },
      });
      await monitor.stop();
      hooks.prepare.mockResolvedValue({ text: "Recovered transcript", suppressAttachments: true });
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      const recovered = restart();
      try {
        recovered.start();
        await recovered.waitForIdle();
        expect(bodies).toEqual(["Recovered transcript"]);
        expect(downloads).not.toHaveBeenCalled();
        await recovered.admit(update());
        await recovered.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        await recovered.stop();
      }
    });
  });
});
