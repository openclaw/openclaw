import { GrammyError } from "grammy";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSpooledReplayDeferredParticipant,
  recordTelegramMessageProcessingResult,
  resolveTelegramUpdateReceivedAtSeconds,
  runWithTelegramUpdateProcessingFrame,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramForumFlag, resolveTelegramMessageThreadSpec } from "./bot/helpers.js";
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import {
  TelegramIngressPayloadError,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";
import { telegramSpooledUpdateLaneKey } from "./telegram-ingress-spool.test-support.js";

type MonitorOptions = Parameters<typeof createTelegramIngressMonitor>[0];
type Queue = MonitorOptions["queue"];
type MakeMonitor = (
  options: Omit<MonitorOptions, "queue" | "getConfig" | "accountId">,
) => ReturnType<typeof createTelegramIngressMonitor>;

function createFixture(stateDir: string) {
  const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
    channelId: "telegram",
    accountId: "default",
    stateDir,
  });
  return {
    stateDir,
    queue,
    monitor: (options: Parameters<MakeMonitor>[0]) =>
      createTelegramIngressMonitor({ queue, ...monitorDefaults, ...options }),
    enqueue: async (updateId: number) => {
      const payload = updatePayload(updateId);
      const eventId = String(updateId).padStart(16, "0");
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      return { eventId, payload, laneKey };
    },
  };
}
async function withTempState<T>(fn: (fixture: ReturnType<typeof createFixture>) => Promise<T>) {
  return withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-telegram-ingress-drain-", applyEnv: false },
    ({ stateDir }) => fn(createFixture(stateDir)),
  );
}

const cfg: OpenClawConfig = {
  channels: { telegram: { allowFrom: ["111"], dmPolicy: "allowlist" } },
};
const monitorDefaults = { getConfig: () => cfg, accountId: "default" };

function updatePayload(updateId: number) {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: { text: "hello", from: { id: 111 }, chat: { id: 111, type: "private" } },
    },
  } satisfies TelegramSpooledUpdatePayload;
}

function telegramSendError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    { chat_id: 111 },
  );
}

async function createTelegramMessageDispatchReplayForgetError(): Promise<unknown> {
  type ReplayGuard = Parameters<typeof commitTelegramMessageDispatchReplay>[0]["guard"];
  type ReplayClaim = import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle;
  const diskError = new Error("dedupe disk write failed");
  const guard: ReplayGuard = {
    claim: async () => ({ kind: "invalid" }),
    forget: async (event) => !("keys" in event && event.keys?.[0] === "first"),
    warmup: async () => 0,
  };
  const claims: ReplayClaim[] = ["first", "second"].map((key) => ({
    keys: [key],
    commit: async (options) => {
      if (key === "second") {
        options?.onDiskError?.(diskError);
      }
      return true;
    },
    release: () => undefined,
  }));
  try {
    await commitTelegramMessageDispatchReplay({ guard, claims, requirePersistent: true });
  } catch (error) {
    return error;
  }
  throw new Error("expected Telegram dispatch rollback failure");
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function startDeferred(makeMonitor: MakeMonitor, name: string) {
  const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
  const dispatch = vi.fn(async () => {
    participant.current = createTelegramSpooledReplayDeferredParticipant(name) ?? undefined;
  });
  const monitor = makeMonitor({ dispatch });
  monitor.start();
  await vi.waitFor(() => expect(participant.current).toBeDefined());
  return { monitor, participant, dispatch };
}

async function expectPending(queue: Queue, rows: Array<Record<string, unknown>>) {
  expect(await queue.listPending({ limit: "all" })).toMatchObject(rows);
}

async function waitPending(queue: Queue, rows: Array<Record<string, unknown>>) {
  await vi.waitFor(() => expectPending(queue, rows));
}

describe("createTelegramIngressMonitor", () => {
  it.each([
    {
      name: "blocked Telegram recipient",
      error: telegramSendError(403, "Forbidden: bot was blocked by the user"),
      reason: "recipient-unreachable",
      message: "bot was blocked by the user",
    },
    {
      name: "wrapped missing harness",
      error: new Error("Agent turn failed", {
        cause: new Error('Requested agent harness "missing-harness-85470" is not registered.'),
      }),
      reason: "missing-agent-harness",
      message: 'Requested agent harness "missing-harness-85470" is not registered.',
    },
    {
      name: "wrapped archived session rejection",
      error: new Error("Command failed", {
        cause: Object.assign(new Error("Restore the archived session before starting work."), {
          name: "SessionWorkStartError",
          reason: "archived",
          retryable: false,
        }),
      }),
      reason: "session-archived",
      message: "Restore the archived session before starting work.",
    },
  ])("dead-letters a $name without retrying it", async ({ error, reason, message }) => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(3);
      const dispatch = vi.fn(async () => ({ kind: "failed-retryable" as const, error }));
      const monitor = makeMonitor({ dispatch });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        expect.objectContaining({ id: eventId, reason, message: expect.stringContaining(message) }),
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    });
  });

  it("keeps a fresh admission lane when the forum cache changes during ACK", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-telegram-ingress-drain-", applyEnv: false },
      async ({ stateDir }) => {
        const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
          channelId: "telegram",
          accountId: "default",
          stateDir,
        });
        const update = {
          update_id: 17,
          message: {
            text: "hello",
            from: { id: 111 },
            chat: { id: -9017, type: "supergroup" },
          },
        };
        await resolveTelegramForumFlag({
          chatId: -9017,
          chatType: "supergroup",
          isGroup: true,
          isForum: false,
        });
        const ackEntered = deferred();
        const ackRelease = deferred();
        const receivedAt = 1_700_000_000_000;
        const delivered: Array<{ laneKey: string | undefined; receivedAt: number }> = [];
        const monitor = createTelegramIngressMonitor({
          queue,
          getConfig: () => cfg,
          accountId: "default",
          botInfo: telegramBotInfoForTest,
          onDurableAdmission: async () => {
            ackEntered.resolve();
            await ackRelease.promise;
          },
          dispatch: async (raw, lifecycle) => {
            const [claim] = await queue.listClaims();
            delivered.push({
              laneKey: claim?.laneKey,
              receivedAt: resolveTelegramUpdateReceivedAtSeconds(raw),
            });
            await lifecycle.onAdopted();
            return { kind: "completed" };
          },
        });
        monitor.start();
        await monitor.waitForIdle();
        const admission = monitor.admit(update, { receivedAt });
        try {
          await ackEntered.promise;
          expect(await queue.listClaims()).toEqual([
            expect.objectContaining({ laneKey: "telegram:-9017", attempts: 0 }),
          ]);
          expect(delivered).toEqual([]);
          await resolveTelegramForumFlag({
            chatId: -9017,
            chatType: "supergroup",
            isGroup: true,
            isForum: true,
          });
          ackRelease.resolve();
          await admission;
          await monitor.waitForIdle();
          expect(delivered).toEqual([{ laneKey: "telegram:-9017", receivedAt: 1_700_000_000 }]);
          expect(await monitor.admit(update)).toMatchObject({
            kind: "durable",
            queueResult: { kind: "completed" },
          });
          expect(delivered).toHaveLength(1);
        } finally {
          ackRelease.resolve();
          await admission;
          await monitor.stop();
        }
      },
    );
  });

  it("reconciles a cached General topic when private bot topics are disabled", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor }) => {
      const eventId = "9".padStart(16, "0");
      const payload = updatePayload(9);
      payload.update.message.chat = { id: -9003, type: "supergroup" };
      await resolveTelegramForumFlag({
        chatId: -9003,
        chatType: "supergroup",
        isGroup: true,
        isForum: true,
      });
      await queue.enqueue(eventId, payload, { laneKey: "telegram:-9003" });

      const dispatch = vi.fn(async (_update, lifecycle) => {
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ laneKey: "telegram:-9003:topic:1" }),
        ]);
        await lifecycle.onAdopted();
        return { kind: "completed" as const };
      });
      const monitor = makeMonitor({
        botInfo: { id: 999, has_topics_enabled: false } as never,
        dispatch,
      });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    });
  });

  it.each([
    {
      name: "private topic",
      updateKind: "edited_message",
      chat: { id: 1234, type: "private" },
      topic: { message_thread_id: 42 },
      laneKey: "telegram:1234:topic:42",
    },
    {
      name: "edited_channel_post",
      updateKind: "edited_channel_post",
      chat: { id: -1234, type: "channel" },
      topic: {},
      laneKey: "telegram:-1234",
    },
    {
      name: "mismatched Direct Messages lane telegram:-1234:approval",
      updateKind: "message",
      chat: { id: -1234, type: "supergroup", is_direct_messages: true },
      topic: { direct_messages_topic: { topic_id: 42 }, message_thread_id: 99 },
      laneKey: "telegram:-1234:approval",
      reject: true,
    },
  ])("replays promoted controls after restart: $name", async (testCase) => {
    await withTempState(async ({ stateDir }) => {
      const queueOptions = { channelId: "telegram", accountId: "default", stateDir };
      const update = {
        update_id: 136,
        [testCase.updateKind]: {
          message_id: 1,
          date: 1_736_380_800,
          from: { id: 111, is_bot: false, first_name: "Ada" },
          chat: testCase.chat,
          ...testCase.topic,
          text: "/models@openclaw_bot",
        },
      };
      const eventId = String(update.update_id).padStart(16, "0");
      const payload = { ...updatePayload(136), receivedAt: 1_736_382_000_123, update };
      await createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions).enqueue(
        eventId,
        payload,
        { laneKey: testCase.laneKey },
      );
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions);
      const controlLaneKey = `telegram:${testCase.chat.id}:control`;
      const dispatch = vi.fn(async (dispatchedUpdate: unknown) => {
        expect(resolveTelegramUpdateReceivedAtSeconds(dispatchedUpdate)).toBe(1_736_382_000);
        expect(await queue.listClaims()).toMatchObject([{ laneKey: controlLaneKey }]);
        return { kind: "completed" as const };
      });
      const monitor = createTelegramIngressMonitor({
        queue,
        ...monitorDefaults,
        botInfo: {
          ...telegramBotInfoForTest,
          has_topics_enabled: true,
        },
        dispatch,
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        if ("reject" in testCase && testCase.reject) {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { reason: "invalid-event", laneKey: testCase.laneKey },
          ]);
          expect(dispatch).not.toHaveBeenCalled();
        } else {
          expect(dispatch).toHaveBeenCalledExactlyOnceWith(update, expect.any(Object));
          expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
          const replay = await queue.enqueue(eventId, payload, { laneKey: controlLaneKey });
          expect(replay.kind).toBe("completed");
        }
        expect(await queue.listPending()).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  const dmTopicChat = { id: 1001, type: "private" };
  const dmTopicUser = { id: 1001, is_bot: false, first_name: "User" };
  const dmTopicCreatedUpdate = () => ({
    update_id: 500,
    message: {
      message_id: 500,
      date: 1_760_000_000,
      chat: dmTopicChat,
      from: dmTopicUser,
      message_thread_id: 500,
      is_topic_message: true,
      forum_topic_created: { name: "hello", icon_color: 0, is_name_implicit: true },
    },
  });
  const dmRootMessageUpdate = () => ({
    update_id: 501,
    message: {
      message_id: 501,
      date: 1_760_000_000,
      chat: dmTopicChat,
      from: dmTopicUser,
      text: "hello",
    },
  });
  const dmTopicsBotInfo = { ...telegramBotInfoForTest, has_topics_enabled: true };

  it("adopts a client-created DM topic at admission and keeps it through restart replay", async () => {
    await withTempState(async (stateDir) => {
      const queueOptions = { channelId: "telegram", accountId: "default", stateDir };
      const eventId = String(501).padStart(16, "0");
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions);
      const dispatchGate = deferred();
      const dispatchEntered = deferred<AbortSignal>();
      const beforeRestart = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch: async (update, lifecycle) => {
          if ((update as { update_id: number }).update_id === 501) {
            // Hold the root message until the owner is aborted (restart before dispatch).
            dispatchEntered.resolve(lifecycle.abortSignal);
            const participant = createTelegramSpooledReplayDeferredParticipant(
              "test:dm-topic-adopt-restart",
            );
            await dispatchGate.promise;
            participant?.settle({ kind: "completed" });
          }
          return { kind: "completed" as const };
        },
      });
      beforeRestart.start();
      let stopped: Promise<void> | undefined;
      try {
        await beforeRestart.admit(dmTopicCreatedUpdate());
        await beforeRestart.admit(dmRootMessageUpdate());
        const ownerSignal = await dispatchEntered.promise;
        // The decision is made once at admission and persisted with the row.
        expect(await queue.listClaims()).toMatchObject([
          { id: eventId, laneKey: "telegram:1001:topic:500", payload: { adoptedDmThreadId: 500 } },
        ]);
        const aborted = new Promise<void>((resolve) => {
          ownerSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped = beforeRestart.stop();
        await aborted;
      } finally {
        dispatchGate.resolve();
        await (stopped ?? beforeRestart.stop());
      }
      // Restart before dispatch: in-memory adoption state and message identity are gone.
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const replayQueue =
        createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions);
      const dispatch = vi.fn(async (update: unknown) => {
        expect(await replayQueue.listClaims()).toMatchObject([
          { id: eventId, laneKey: "telegram:1001:topic:500" },
        ]);
        const message = (
          update as { message: Parameters<typeof resolveTelegramMessageThreadSpec>[0] }
        ).message;
        expect(resolveTelegramMessageThreadSpec(message)).toEqual({ id: 500, scope: "dm" });
        return { kind: "completed" as const };
      });
      const afterRestart = createTelegramIngressMonitor({
        queue: replayQueue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch,
      });
      try {
        afterRestart.start();
        await afterRestart.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await replayQueue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await replayQueue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await afterRestart.stop();
      }
    });
  });

  it("does not rearm adoption when the service message is redelivered after a native topic message", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const root = dmRootMessageUpdate();
      const nativeTopicUpdate = {
        update_id: 501,
        message: { ...root.message, message_thread_id: 500, is_topic_message: true },
      };
      const laterRootUpdate = {
        update_id: 502,
        message: { ...root.message, message_id: 502 },
      };
      const resolved = new Map<number, ReturnType<typeof resolveTelegramMessageThreadSpec>>();
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch: async (update) => {
          const { update_id: updateId, message } = update as {
            update_id: number;
            message: Parameters<typeof resolveTelegramMessageThreadSpec>[0];
          };
          resolved.set(updateId, resolveTelegramMessageThreadSpec(message));
          return { kind: "completed" as const };
        },
      });
      try {
        monitor.start();
        await monitor.admit(dmTopicCreatedUpdate());
        await monitor.admit(nativeTopicUpdate);
        // Telegram redelivers the spent service message: admission inspects it again.
        await monitor.admit(dmTopicCreatedUpdate()).catch(() => undefined);
        await monitor.admit(laterRootUpdate);
        await monitor.waitForIdle();
        expect(resolved.get(501)).toEqual({ id: 500, scope: "dm" });
        expect(resolved.get(502)).toEqual({ scope: "dm" });
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("replays legacy spool rows without adoptedDmThreadId unchanged and restores it from new rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = (updateId: number) => String(updateId).padStart(16, "0");
      // Row written before the optional field existed: same shape as any root message.
      const legacy: TelegramSpooledUpdatePayload = {
        version: 1,
        updateId: 501,
        receivedAt: 501,
        update: dmRootMessageUpdate(),
      };
      const root = dmRootMessageUpdate();
      const adopted: TelegramSpooledUpdatePayload = {
        version: 1,
        updateId: 502,
        receivedAt: 502,
        update: { ...root, update_id: 502, message: { ...root.message, message_id: 502 } },
        adoptedDmThreadId: 500,
      };
      await queue.enqueue(eventId(501), legacy, { laneKey: "telegram:1001" });
      await queue.enqueue(eventId(502), adopted, { laneKey: "telegram:1001:topic:500" });
      const lanes = new Map<number, string | undefined>();
      const resolved = new Map<number, ReturnType<typeof resolveTelegramMessageThreadSpec>>();
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch: async (update) => {
          const { update_id: updateId, message } = update as {
            update_id: number;
            message: Parameters<typeof resolveTelegramMessageThreadSpec>[0];
          };
          const claims = await queue.listClaims();
          lanes.set(updateId, claims.find((claim) => claim.id === eventId(updateId))?.laneKey);
          resolved.set(updateId, resolveTelegramMessageThreadSpec(message));
          return { kind: "completed" as const };
        },
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        expect(lanes).toEqual(
          new Map([
            [501, "telegram:1001"],
            [502, "telegram:1001:topic:500"],
          ]),
        );
        expect(resolved).toEqual(
          new Map([
            [501, { scope: "dm" }],
            [502, { id: 500, scope: "dm" }],
          ]),
        );
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps the adopted topic for a redelivery after every durable append attempt failed", async () => {
    await withTempState(async (stateDir) => {
      const eventId = String(501).padStart(16, "0");
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const enqueue = vi.spyOn(queue, "enqueue");
      const dispatch = vi.fn(async (update: unknown) => {
        const { update_id: updateId, message } = update as {
          update_id: number;
          message: Parameters<typeof resolveTelegramMessageThreadSpec>[0];
        };
        if (updateId === 501) {
          expect(await queue.listClaims()).toMatchObject([
            {
              id: eventId,
              laneKey: "telegram:1001:topic:500",
              payload: { adoptedDmThreadId: 500 },
            },
          ]);
          expect(resolveTelegramMessageThreadSpec(message)).toEqual({ id: 500, scope: "dm" });
        }
        return { kind: "completed" as const };
      });
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch,
      });
      try {
        monitor.start();
        await monitor.admit(dmTopicCreatedUpdate());
        await monitor.waitForIdle();
        // Every append attempt for the root message fails: the webhook answers 500 and
        // Telegram redelivers the update as a freshly parsed object.
        enqueue.mockRejectedValue(new Error("append failed"));
        await expect(monitor.admit(dmRootMessageUpdate())).rejects.toThrow("append failed");
        enqueue.mockRestore();
        await monitor.admit(dmRootMessageUpdate());
        await monitor.waitForIdle();
        expect(
          dispatch.mock.calls.map(([update]) => (update as { update_id: number }).update_id),
        ).toEqual([500, 501]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("scopes client-created DM topic adoption to the receiving bot account", async () => {
    await withTempState(async (stateDir) => {
      const resolved: Record<
        "a" | "b",
        Array<ReturnType<typeof resolveTelegramMessageThreadSpec>>
      > = {
        a: [],
        b: [],
      };
      const lanes: Record<"a" | "b", string[]> = { a: [], b: [] };
      const createAccountMonitor = (accountId: "a" | "b") => {
        const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
          channelId: "telegram",
          accountId,
          stateDir,
        });
        return createTelegramIngressMonitor({
          queue,
          getConfig: () => cfg,
          accountId,
          botInfo: dmTopicsBotInfo,
          dispatch: async (update) => {
            lanes[accountId].push(
              ...(await queue.listClaims()).map((claim) => claim.laneKey ?? ""),
            );
            const message = (
              update as { message: Parameters<typeof resolveTelegramMessageThreadSpec>[0] }
            ).message;
            resolved[accountId].push(resolveTelegramMessageThreadSpec(message));
            return { kind: "completed" as const };
          },
        });
      };
      const botA = createAccountMonitor("a");
      const botB = createAccountMonitor("b");
      try {
        botA.start();
        botB.start();
        await botA.admit(dmTopicCreatedUpdate());
        // The same user's root message to bot B never consumes bot A's topic.
        await botB.admit(dmRootMessageUpdate());
        await botA.admit(dmRootMessageUpdate());
        await botA.waitForIdle();
        await botB.waitForIdle();
        expect(lanes.b).toEqual(["telegram:1001"]);
        expect(resolved.b).toEqual([{ scope: "dm" }]);
        expect(lanes.a).toEqual(["telegram:1001:topic:500", "telegram:1001:topic:500"]);
        expect(resolved.a).toEqual([
          { id: 500, scope: "dm" },
          { id: 500, scope: "dm" },
        ]);
      } finally {
        await botA.stop();
        await botB.stop();
      }
    });
  });

  it.each([
    new Error("late provider blip"),
    Object.assign(new Error("workspace is not ready"), {
      name: "SessionWorkStartError",
      reason: "workspace_pending",
      retryable: true,
    }),
    new Error("Session is archived"),
  ])("preserves retry for a late deferred failure: %s", async (error) => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(4);
      const { monitor, participant } = await startDeferred(makeMonitor, "test:late-retry");
      expect(await queue.listClaims()).toHaveLength(1);
      participant.current?.settle({ kind: "failed-retryable", error });

      await waitPending(queue, [{ id: eventId, attempts: 1, lastError: error.message }]);
      await monitor.stop();
    });
  });

  it("dead-letters a late deferred dispatch dedupe rollback failure", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(5);
      const { monitor, participant, dispatch } = await startDeferred(
        makeMonitor,
        "test:late-fatal",
      );
      participant.current?.settle({
        kind: "failed-retryable",
        error: await createTelegramMessageDispatchReplayForgetError(),
      });

      await vi.waitFor(async () =>
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: eventId, reason: "dispatch-dedupe-rollback-failed" },
        ]),
      );
      await monitor.waitForIdle();
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(dispatch).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });

  it("releases an aborted deferred claim after a late completed settlement", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(6);
      const { monitor, participant } = await startDeferred(makeMonitor, "test:late-completed");
      await monitor.stop();
      expect(await queue.listClaims()).toEqual([]);
      await expectPending(queue, [{ id: eventId, attempts: 0 }]);

      participant.current?.settle({ kind: "completed" });
      await waitPending(queue, [{ id: eventId, attempts: 0 }]);
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });

  it("uses participant settlement to own the row despite frame completion after abort", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const started = deferred();
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
            const participant = createTelegramSpooledReplayDeferredParticipant("test:inline-abort");
            expect(participant).not.toBeNull();
            const aborted = new Promise<void>((resolve) => {
              lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
            started.resolve();
            await aborted;
            recordTelegramMessageProcessingResult({ kind: "completed" });
            participant?.settle({ kind: "skipped" });
            await participant?.task;
          });
          return result;
        },
      });

      monitor.start();
      await started.promise;
      await monitor.stop();

      await expectPending(queue, [{ id: eventId, attempts: 0 }]);
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });

  it("uses participant adoption to own the row despite a failed frame outcome", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const release = vi.spyOn(queue, "release");
      const monitor = makeMonitor({
        dispatch: async () => {
          const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
            const participant = createTelegramSpooledReplayDeferredParticipant("test:adopted");
            expect(participant).not.toBeNull();
            recordTelegramMessageProcessingResult({
              kind: "failed-retryable",
              error: new Error("late frame failure"),
            });
            participant?.settle({ kind: "completed" });
            await participant?.task;
          });
          return result;
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).toBe("completed");
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(release).not.toHaveBeenCalled();
    });
  });

  it("preserves an adopted tombstone when inline completion returns after shutdown", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const adopted = deferred();
      const finishDispatch = deferred();
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          adopted.resolve();
          await finishDispatch.promise;
          return { kind: "completed" };
        },
      });

      monitor.start();
      await adopted.promise;
      const stopped = monitor.stop();
      finishDispatch.resolve();
      await stopped;

      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).toBe("completed");
    });
  });

  it("requeues an aborted deferred participant even when its late result is non-retryable", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(9);
      const { monitor, participant } = await startDeferred(
        makeMonitor,
        "test:aborted-non-retryable",
      );
      await monitor.stop();
      participant.current?.settle({
        kind: "failed-retryable",
        error: new TelegramIngressPayloadError("late invalid payload"),
      });

      await waitPending(queue, [{ id: eventId, attempts: 0 }]);
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
    });
  });

  it("releases when dispatch settles only after its owner was aborted", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const priorClaim = await queue.claim(eventId, { ownerId: "prior-owner" });
      if (!priorClaim) {
        throw new Error("Expected the prior Telegram ingress claim.");
      }
      const priorAttemptAt = Date.now() - 10_000;
      await queue.release(priorClaim, {
        releasedAt: priorAttemptAt,
        lastError: "previous delivery failed",
      });
      const dispatchGate = deferred();
      let ownerSignal: AbortSignal | undefined;
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          ownerSignal = lifecycle.abortSignal;
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:abort-before-settlement",
          );
          await dispatchGate.promise;
          participant?.settle({ kind: "completed" });
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(ownerSignal).toBeDefined());
      const stopped = monitor.stop();
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      dispatchGate.resolve();
      await stopped;

      await waitPending(queue, [
        {
          id: eventId,
          attempts: 1,
          lastAttemptAt: priorAttemptAt,
          lastError: "previous delivery failed",
        },
      ]);
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });
});
