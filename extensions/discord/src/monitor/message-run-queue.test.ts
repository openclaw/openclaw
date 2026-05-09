import { describe, expect, it, vi } from "vitest";
import type { DiscordInboundJob } from "./inbound-job.js";
import type {
  DiscordMessagePreflightContext,
  RuntimeEnv,
} from "./message-handler.preflight.types.js";
import { createDiscordMessageRunQueue } from "./message-run-queue.js";

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function createJob(params: { messageId: string; queueKey?: string }): DiscordInboundJob {
  return {
    queueKey: params.queueKey ?? "session-1",
    payload: {
      messageId: params.messageId,
      message: { id: params.messageId },
      data: { message: { id: params.messageId } },
    },
    runtime: {},
  } as unknown as DiscordInboundJob;
}

describe("createDiscordMessageRunQueue", () => {
  it("preserves FIFO execution for queued jobs in the same session", async () => {
    const firstRun = createDeferred();
    const processed: string[] = [];
    const queue = createDiscordMessageRunQueue({
      runtime: createRuntime(),
      __testing: {
        processDiscordMessage: vi.fn(async (ctx: DiscordMessagePreflightContext) => {
          processed.push(ctx.message.id ?? "unknown");
          if (ctx.message.id === "m-1") {
            await firstRun.promise;
          }
        }),
      },
    });

    queue.enqueue(createJob({ messageId: "m-1" }));
    queue.enqueue(createJob({ messageId: "m-2" }));

    await flushQueueWork();
    expect(processed).toEqual(["m-1"]);

    firstRun.resolve?.();
    await firstRun.promise;
    await flushQueueWork();

    expect(processed).toEqual(["m-1", "m-2"]);
  });

  it("drops new jobs when a session reaches the configured pending limit", async () => {
    const firstRun = createDeferred();
    const runtime = createRuntime();
    const processed: string[] = [];
    const queue = createDiscordMessageRunQueue({
      runtime,
      maxPendingPerSession: 1,
      __testing: {
        processDiscordMessage: vi.fn(async (ctx: DiscordMessagePreflightContext) => {
          processed.push(ctx.message.id ?? "unknown");
          if (ctx.message.id === "m-1") {
            await firstRun.promise;
          }
        }),
      },
    });

    queue.enqueue(createJob({ messageId: "m-1" }));
    await flushQueueWork();
    queue.enqueue(createJob({ messageId: "m-2" }));
    queue.enqueue(createJob({ messageId: "m-3" }));

    await flushQueueWork();
    expect(processed).toEqual(["m-1"]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord message queue full for session session-1"),
    );

    firstRun.resolve?.();
    await firstRun.promise;
    await flushQueueWork();

    expect(processed).toEqual(["m-1", "m-2"]);
  });

  it("skips stale queued jobs when maxQueuedAgeMs is configured", async () => {
    vi.useFakeTimers();
    try {
      const firstRun = createDeferred();
      const runtime = createRuntime();
      const processed: string[] = [];
      const queue = createDiscordMessageRunQueue({
        runtime,
        maxQueuedAgeMs: 100,
        __testing: {
          processDiscordMessage: vi.fn(async (ctx: DiscordMessagePreflightContext) => {
            processed.push(ctx.message.id ?? "unknown");
            if (ctx.message.id === "m-1") {
              await firstRun.promise;
            }
          }),
        },
      });

      queue.enqueue(createJob({ messageId: "m-1" }));
      await vi.runAllTicks();
      await flushQueueWork();
      queue.enqueue(createJob({ messageId: "m-2" }));

      await vi.advanceTimersByTimeAsync(101);
      firstRun.resolve?.();
      await firstRun.promise;
      await flushQueueWork();

      expect(processed).toEqual(["m-1"]);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("discord message queue dropped stale job for session session-1"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
