import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import {
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";

installDiscordIngressTestRuntime();
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
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ingressRuntime from "./ingress.js";
import type { DiscordIngressLifecycle } from "./ingress.js";
const createDiscordIngressMonitor = ingressRuntime.createDiscordIngressMonitor;
import { createDiscordMessageHandler } from "./message-handler.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import { createDiscordHandlerParams } from "./message-handler.test-helpers.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

function createRawMessage(id: string, channelId = "channel-1"): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: { id: "user-1", username: "alice", discriminator: "0", avatar: null },
  } as unknown as APIMessage;
}

function payloadFor(rawMessage: APIMessage): DiscordIngressPayload {
  return { version: 1, receivedAt: Date.now(), rawMessage };
}

let stateDir: string;
let queue: ChannelIngressQueue<DiscordIngressPayload>;
const monitors = new Set<ReturnType<typeof createDiscordIngressMonitor>>();
beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-")),
  );
  queue = createChannelIngressQueueForTests({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
});
afterEach(async () => {
  try {
    await Promise.all(Array.from(monitors, (monitor) => monitor.stop()));
  } finally {
    monitors.clear();
    resetGlobalHookRunner();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

function createPausedMonitor(
  dispatch: Parameters<typeof createDiscordIngressMonitor>[0]["dispatch"],
  ingressQueue = queue,
) {
  const monitor = createDiscordIngressMonitor({
    accountId: "default",
    client: {} as never,
    runtime: { error: vi.fn(), log: vi.fn() },
    queue: ingressQueue,
    dispatch,
  });
  monitors.add(monitor);
  return monitor;
}
function createMonitor(...args: Parameters<typeof createPausedMonitor>) {
  const monitor = createPausedMonitor(...args);
  monitor.start();
  return monitor;
}

describe("Discord durable ingress", () => {
  it("stores only the awaited ingress transform, before any message dispatch", async () => {
    const raw = {
      ...createRawMessage("privacy-event"),
      content: "PRIVATE_PAYLOAD_SENTINEL",
      attachments: [{ id: "upload", url: "https://example.invalid/private-upload" }],
    } as unknown as APIMessage;
    const prepared = createDeferred<void>();
    const release = createDeferred<void>();
    const policyOrder: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          handler: async (input) => {
            const message = (input as { event: APIMessage }).event;
            policyOrder.push(message.id);
            if (message.id === raw.id) {
              prepared.resolve();
              await release.promise;
            }
            return { event: { ...message, content: "[redacted]", attachments: [] } };
          },
        },
      ]),
    );
    const dispatch = vi.fn();
    const monitor = createPausedMonitor(dispatch);
    const admission = monitor.accept(raw);
    let follower: Promise<void> | undefined;
    try {
      await Promise.race([prepared.promise, admission]);
      follower = monitor.accept({ ...raw, id: "privacy-follower" });
      expect(policyOrder).toEqual([raw.id]);
      expect(await queue.listPending()).toEqual([]);
      release.resolve();
      await Promise.all([admission, follower]);
      expect(policyOrder).toEqual([raw.id, "privacy-follower"]);
      const pending = await queue.listPending();
      expect(pending).toMatchObject([
        {
          id: raw.id,
          laneKey: "channel:channel-1",
          payload: { rawMessage: { content: "[redacted]", attachments: [] } },
        },
        {
          id: "privacy-follower",
          payload: { rawMessage: { content: "[redacted]", attachments: [] } },
        },
      ]);
      expect(JSON.stringify(pending)).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
      expect(JSON.stringify(pending)).not.toContain("private-upload");
      for (const entry of (await listDirectoryTreeStrict(stateDir)).map(
        (walkEntry) => walkEntry.dirent,
      )) {
        if (entry.isFile()) {
          const bytes = await fs.readFile(path.join(entry.parentPath, entry.name));
          expect(bytes.includes(Buffer.from("PRIVATE_PAYLOAD_SENTINEL"))).toBe(false);
          expect(bytes.includes(Buffer.from("private-upload"))).toBe(false);
        }
      }
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([admission, follower]);
    }
  });

  it("rejects an ingress policy failure without storing its raw payload or error", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_ingress",
          handler: () => {
            throw new Error("PRIVATE_SCOPE_LOOKUP_SENTINEL");
          },
        },
      ]),
    );
    const monitor = createPausedMonitor(vi.fn());
    await expect(monitor.accept(createRawMessage("denied"))).rejects.toThrow(
      "Channel ingress transform failed",
    );
    expect(await queue.listPending()).toEqual([]);
  });

  it.each(["id", "channel_id"] as const)(
    "refuses a transform that changes the provider %s",
    async (field) => {
      const raw = createRawMessage("identity-event");
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_channel_ingress",
            handler: () => ({ event: { ...raw, [field]: "changed" } }),
          },
        ]),
      );
      const monitor = createPausedMonitor(vi.fn());
      await expect(monitor.accept(raw)).rejects.toThrow("changed event identity or lane");
      expect(await queue.listPending()).toEqual([]);
    },
  );

  it("admits a same-channel correction while an earlier claim is deferred and a run is active", async () => {
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
    preflightDiscordMessageMock.mockImplementation(async (input) => ({
      ...baseContext,
      data: input.data,
      message: input.data.message,
      turnAdoptionLifecycle: input.turnAdoptionLifecycle,
      abortSignal: input.abortSignal,
    }));
    processDiscordMessageMock.mockImplementation(async (ctx) => {
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
    });
    vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation((monitorParams) =>
      createDiscordIngressMonitor({ ...monitorParams, queue }),
    );
    const handler = createDiscordMessageHandler({
      ...params,
      client: {} as never,
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

  it("does not normalize or dispatch before the durable append completes", async () => {
    const appendGate = createDeferred<void>();
    const appendStarted = createDeferred<void>();
    const gateAppend = vi.fn(async () => {
      appendStarted.resolve();
      await appendGate.promise;
    });
    // An idle monitor admits a fresh singleton through the fused append-and-claim.
    const enqueueAndClaim = queue.enqueueAndClaim?.bind(queue);
    const gatedQueue: ChannelIngressQueue<DiscordIngressPayload> = {
      ...queue,
      enqueue: async (...args) => {
        await gateAppend();
        return await queue.enqueue(...args);
      },
      enqueueAndClaim:
        enqueueAndClaim &&
        (async (...args) => {
          await gateAppend();
          return await enqueueAndClaim(...args);
        }),
    };
    const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(dispatch, gatedQueue);
    const accepted = monitor.accept(createRawMessage("1001"));
    try {
      await Promise.race([appendStarted.promise, accepted]);
      expect(gateAppend).toHaveBeenCalledTimes(1);

      expect(dispatch).not.toHaveBeenCalled();

      appendGate.resolve();
      await accepted;
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    } finally {
      appendGate.resolve();
      await accepted;
    }
  });

  it("rejects unstable message identity before durable allocation", async () => {
    const dispatch = vi.fn();
    const monitor = createMonitor(dispatch);
    const missingMessageId = { ...createRawMessage("missing"), id: undefined };
    const missingChannelId = { ...createRawMessage("missing"), channel_id: undefined };

    await expect(monitor.accept(missingMessageId as never)).rejects.toThrow("snowflake");
    await expect(monitor.accept(missingChannelId as never)).rejects.toThrow("channel_id");
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers a claimed row with a fresh drain and dispatches it exactly once", async () => {
    const firstDispatch = vi.fn(async () => ({ kind: "deferred" as const }));
    const first = createMonitor(firstDispatch);
    await first.accept(createRawMessage("1002"));
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
    await first.stop();

    const recoveredDispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
      await lifecycle.onAdopted();
    });
    createMonitor(recoveredDispatch);

    await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(recoveredDispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate after completion", async () => {
    const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(dispatch);
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
  });

  it("matches the old guard for duplicate MESSAGE_CREATE delivery during RESUME", async () => {
    let lifecycle: DiscordIngressLifecycle | undefined;
    const dispatch = vi.fn(async (_event, claimedLifecycle: DiscordIngressLifecycle) => {
      lifecycle = claimedLifecycle;
      return { kind: "deferred" as const };
    });
    const monitor = createMonitor(dispatch);
    const replayed = createRawMessage("1004");
    await Promise.all([monitor.accept(replayed), monitor.accept(replayed)]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    await lifecycle?.onAdopted();
    await vi.waitFor(async () => {
      const verdict = await queue.enqueue("1004", payloadFor(replayed));
      expect(verdict.kind).toBe("completed");
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dead-letters a permanent Discord authentication failure", async () => {
    const monitor = createMonitor(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const rawMessage = createRawMessage("1005");
    await monitor.accept(rawMessage);
    await vi.waitFor(async () => {
      const verdict = await queue.enqueue("1005", payloadFor(rawMessage));
      expect(verdict.kind).toBe("failed");
    });
  });
});
