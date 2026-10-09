import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover durable gateway-message admission and replay recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import { createDiscordHandlerParams } from "./message-handler.test-helpers.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

function createRawMessage(id: string, channelId = "channel-1", authorId = "user-1"): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: authorId,
      username: authorId,
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function payloadFor(rawMessage: APIMessage): DiscordIngressPayload {
  return { version: 1, receivedAt: Date.now(), rawMessage };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>, stateDir: string) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue, stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

type DiscordIngressMonitor = ReturnType<typeof createDiscordIngressMonitor>;

async function stopAll(monitors: DiscordIngressMonitor[]): Promise<void> {
  await Promise.allSettled(monitors.map((monitor) => monitor.stop()));
}

describe("Discord durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("admits a same-channel correction while an earlier claim is deferred and a run is active", async () => {
    await withQueue(async (queue, stateDir) => {
      const activeStarted = createDeferred<void>();
      const finishActive = createDeferred<void>();
      const deferredStarted = createDeferred<DiscordIngressLifecycle>();
      const markerAdopted = createDeferred<void>();
      const processed: string[] = [];
      const complete = vi.spyOn(queue, "complete");
      const params = createDiscordHandlerParams();
      const baseContext = await createBaseDiscordMessageContext(
        { threadBindings: params.threadBindings },
        { storePath: path.join(stateDir, "sessions.json") },
      );
      const handler = createDiscordMessageHandler({
        ...params,
        client: {} as never,
        testing: {
          preflightDiscordMessage: async (input) => ({
            ...baseContext,
            data: input.data,
            message: input.data.message,
            turnAdoptionLifecycle: input.turnAdoptionLifecycle,
            abortSignal: input.abortSignal,
          }),
          processDiscordMessage: async (ctx) => {
            const lifecycle = ctx.turnAdoptionLifecycle;
            if (!lifecycle) {
              throw new Error("Expected a durable Discord lifecycle");
            }
            processed.push(ctx.message.id);
            if (ctx.message.id === "1007") {
              lifecycle.onDeferred();
              deferredStarted.resolve(lifecycle);
              return;
            }
            await lifecycle.onAdopted();
            if (ctx.message.id === "1006") {
              activeStarted.resolve();
              await finishActive.promise;
            } else if (ctx.message.id === "1009") {
              markerAdopted.resolve();
            }
          },
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });
      try {
        await handler(createRawMessage("1006"), {} as never);
        await activeStarted.promise;
        await handler(createRawMessage("1007"), {} as never);
        const deferredLifecycle = await deferredStarted.promise;
        const [deferredClaim] = await queue.listClaims();
        expect(deferredClaim?.id).toBe("1007");

        await handler(createRawMessage("1008"), {} as never);
        // A later message in another lane reaches adoption even when the
        // correction is blocked, so the regression fails without a timeout.
        await handler(createRawMessage("1009", "channel-2"), {} as never);
        await markerAdopted.promise;
        expect(processed).toEqual(["1006", "1007", "1008", "1009"]);
        expect(await queue.listClaims()).toMatchObject([
          {
            id: "1007",
            claim: {
              token: deferredClaim?.claim.token,
              ownerId: deferredClaim?.claim.ownerId,
            },
          },
        ]);

        await deferredLifecycle.onAdopted();
        expect(await queue.listClaims()).toEqual([]);
        await expect(
          queue.enqueue("1007", payloadFor(createRawMessage("1007"))),
        ).resolves.toMatchObject({ kind: "completed" });
        expect(
          complete.mock.calls.filter(
            ([claim]) => (typeof claim === "string" ? claim : claim.id) === "1007",
          ),
        ).toHaveLength(1);
      } finally {
        finishActive.resolve();
        await handler.deactivate();
      }
    });
  });

  it("keeps a later sender's turn behind an earlier message still before reply admission", async () => {
    await withQueue(async (queue, stateDir) => {
      const firstStarted = createDeferred<DiscordIngressLifecycle>();
      const releaseFirst = createDeferred<void>();
      const laterEntered = createDeferred<void>();
      const laterProcessed = createDeferred<void>();
      const markerProcessed = createDeferred<void>();
      const processed: string[] = [];
      const params = createDiscordHandlerParams();
      const baseContext = await createBaseDiscordMessageContext(
        { threadBindings: params.threadBindings },
        { storePath: path.join(stateDir, "sessions.json") },
      );
      const handler = createDiscordMessageHandler({
        ...params,
        client: {} as never,
        testing: {
          preflightDiscordMessage: async (input) => ({
            ...baseContext,
            data: input.data,
            message: input.data.message,
            turnAdoptionLifecycle: input.turnAdoptionLifecycle,
            abortSignal: input.abortSignal,
          }),
          // Stands in for the channel turn kernel, which awaits this turn first.
          processDiscordMessage: async (ctx) => {
            const lifecycle = ctx.turnAdoptionLifecycle;
            if (!lifecycle) {
              throw new Error("Expected a durable Discord lifecycle");
            }
            if (ctx.message.id === "2002") {
              laterEntered.resolve();
            }
            await lifecycle.admissionTurn?.wait();
            processed.push(ctx.message.id);
            if (ctx.message.id === "2001") {
              // Still preflighting: no reply admission until the test releases it.
              firstStarted.resolve(lifecycle);
              await releaseFirst.promise;
              lifecycle.onDeferred();
              return;
            }
            await lifecycle.onAdopted();
            (ctx.message.id === "2002" ? laterProcessed : markerProcessed).resolve();
          },
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });
      try {
        await handler(createRawMessage("2001", "channel-1", "user-1"), {} as never);
        const first = await firstStarted.promise;
        await handler(createRawMessage("2002", "channel-1", "user-2"), {} as never);
        await laterEntered.promise;
        // Another lane still flows, and gives the held turn time to overtake.
        await handler(createRawMessage("2003", "channel-2", "user-2"), {} as never);
        await markerProcessed.promise;
        expect(processed).toEqual(["2001", "2003"]);

        // Queued reply admission releases the later sender before adoption.
        releaseFirst.resolve();
        await laterProcessed.promise;
        expect(processed).toEqual(["2001", "2003", "2002"]);
        await first.onAdopted();
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        releaseFirst.resolve();
        await handler.deactivate();
      }
    });
  });

  it("does not normalize or dispatch before the durable append completes", async () => {
    await withQueue(async (queue) => {
      const appendGate = createDeferred<void>();
      const appendStarted = createDeferred<void>();
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        appendStarted.resolve();
        await appendGate.promise;
        return await queue.enqueue(...args);
      });
      const gatedQueue: ChannelIngressQueue<DiscordIngressPayload> = { ...queue, enqueue };
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue: gatedQueue,
        dispatch,
      });
      monitor.start();
      const accepted = monitor.accept(createRawMessage("1001"));
      try {
        await Promise.race([appendStarted.promise, accepted]);
        expect(enqueue).toHaveBeenCalledTimes(1);

        expect(dispatch).not.toHaveBeenCalled();

        appendGate.resolve();
        await accepted;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        appendGate.resolve();
        try {
          await accepted;
        } finally {
          await monitor.stop();
        }
      }
    });
  });

  it("rejects unstable message identity before durable allocation", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const missingMessageId = { ...createRawMessage("missing"), id: undefined };
        const missingChannelId = { ...createRawMessage("missing"), channel_id: undefined };

        await expect(monitor.accept(missingMessageId as never)).rejects.toThrow("snowflake");
        await expect(monitor.accept(missingChannelId as never)).rejects.toThrow("channel_id");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers a claimed row with a fresh drain and dispatches it exactly once", async () => {
    await withQueue(async (queue) => {
      const monitors: DiscordIngressMonitor[] = [];
      const firstDispatch = vi.fn(async () => ({ kind: "deferred" as const }));
      const first = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: firstDispatch,
      });
      monitors.push(first);
      first.start();
      try {
        await first.accept(createRawMessage("1002"));
        await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
        await first.stop();

        const recoveredDispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const recovered = createDiscordIngressMonitor({
          accountId: "default",
          client: {} as never,
          runtime: runtime(),
          queue,
          dispatch: recoveredDispatch,
        });
        monitors.push(recovered);
        recovered.start();

        await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await stopAll(monitors);
      }
    });
  });

  it("rejects a duplicate after completion", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1003");
        await monitor.accept(rawMessage);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1003", payloadFor(rawMessage));
          expect(verdict.kind).toBe("completed");
        });

        await monitor.accept(rawMessage);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("matches the old guard for duplicate MESSAGE_CREATE delivery during RESUME", async () => {
    await withQueue(async (queue) => {
      let lifecycle: DiscordIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_event, claimedLifecycle: DiscordIngressLifecycle) => {
        lifecycle = claimedLifecycle;
        return { kind: "deferred" as const };
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const replayed = createRawMessage("1004");
        await Promise.all([monitor.accept(replayed), monitor.accept(replayed)]);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

        await lifecycle?.onAdopted();
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1004", payloadFor(replayed));
          expect(verdict.kind).toBe("completed");
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters a permanent Discord authentication failure", async () => {
    await withQueue(async (queue) => {
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1005");
        await monitor.accept(rawMessage);
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1005", payloadFor(rawMessage));
          expect(verdict.kind).toBe("failed");
        });
      } finally {
        await monitor.stop();
      }
    });
  });
});
