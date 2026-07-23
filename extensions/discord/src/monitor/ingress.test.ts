// Discord tests cover durable gateway-message admission and replay recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";

const sendMessageDiscordMock = vi.hoisted(() =>
  vi.fn(async (_to: string, _text: string, _opts: unknown) => ({
    ok: true,
    messageId: "timeout-note",
    channelId: "channel-1",
  })),
);

vi.mock("../send.js", () => ({ sendMessageDiscord: sendMessageDiscordMock }));

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

const TEST_CFG: OpenClawConfig = {
  channels: {
    discord: {
      token: "test-token",
    },
  },
};

function createRawMessage(id: string, channelId = "channel-1"): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
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
    sendMessageDiscordMock.mockReset();
    vi.useRealTimers();
  });

  it("does not normalize or dispatch before the durable append completes", async () => {
    await withQueue(async (queue) => {
      const appendGate = createDeferred();
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
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
      try {
        const accepted = monitor.accept(createRawMessage("1001"));
        await Promise.resolve();

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(dispatch).not.toHaveBeenCalled();

        appendGate.resolve();
        await accepted;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
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

  it("sends a visible reply when handler adoption times out", async () => {
    vi.useFakeTimers();
    sendMessageDiscordMock.mockResolvedValue({
      ok: true,
      messageId: "timeout-note",
      channelId: "channel-timeout",
    });
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => ({ kind: "deferred" as const }));
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        cfg: TEST_CFG,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        await monitor.accept(createRawMessage("timeout-1", "channel-timeout"));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        await vi.waitFor(() => expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1));
        expect(sendMessageDiscordMock).toHaveBeenCalledWith(
          "channel:channel-timeout",
          "Discord gateway was busy and timed out before handling this message.\nPlease retry the request in a minute.",
          expect.objectContaining({
            cfg: TEST_CFG,
            accountId: "default",
            reply: { messageId: "timeout-1", scope: "all" },
          }),
        );
      } finally {
        await monitor.stop();
      }
    });
  });
});
