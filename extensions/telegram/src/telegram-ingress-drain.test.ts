// Telegram ingress drain adapter: dispatch result propagation.
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

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-telegram-ingress-drain-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["111"],
      dmPolicy: "allowlist",
    },
  },
} as OpenClawConfig;

function updatePayload(updateId: number): TelegramSpooledUpdatePayload {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: {
        text: "hello",
        from: { id: 111 },
        chat: { id: 111, type: "private" },
      },
    },
  };
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
    await commitTelegramMessageDispatchReplay({
      guard,
      claims,
      requirePersistent: true,
    });
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
  ])("dead-letters a $name without retrying it", async ({ error, reason, message }) => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "3".padStart(16, "0");
      const payload = updatePayload(3);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const dispatch = vi.fn(async () => ({ kind: "failed-retryable" as const, error }));
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        dispatch,
      });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: eventId,
          reason,
          message: expect.stringContaining(message),
        }),
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);

      await monitor.stop();
    });
  });

  it("reconciles a cached General topic when private bot topics are disabled", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const updateId = 9;
      const eventId = String(updateId).padStart(16, "0");
      const update = {
        update_id: updateId,
        message: {
          text: "hello",
          from: { id: 111 },
          chat: { id: -9003, type: "supergroup" },
        },
      };
      const payload: TelegramSpooledUpdatePayload = {
        version: 1,
        updateId,
        receivedAt: updateId,
        update,
      };
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
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
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
    await withTempState(async (stateDir) => {
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
      const payload: TelegramSpooledUpdatePayload = {
        version: 1,
        updateId: update.update_id,
        receivedAt: Date.now(),
        update,
      };
      await createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions).enqueue(
        eventId,
        payload,
        { laneKey: testCase.laneKey },
      );
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>(queueOptions);
      const controlLaneKey = `telegram:${testCase.chat.id}:control`;
      const dispatch = vi.fn(async () => {
        expect(await queue.listClaims()).toMatchObject([{ laneKey: controlLaneKey }]);
        return { kind: "completed" as const };
      });
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
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
          expect(await queue.enqueue(eventId, payload, { laneKey: controlLaneKey })).toMatchObject({
            kind: "completed",
          });
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
      let finishDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      let ownerSignal: AbortSignal | undefined;
      const beforeRestart = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        botInfo: dmTopicsBotInfo,
        dispatch: async (update, lifecycle) => {
          if ((update as { update_id: number }).update_id === 501) {
            // Hold the root message until the owner is aborted (restart before dispatch).
            ownerSignal = lifecycle.abortSignal;
            const participant = createTelegramSpooledReplayDeferredParticipant(
              "test:dm-topic-adopt-restart",
            );
            await dispatchGate;
            participant?.settle({ kind: "completed" });
          }
          return { kind: "completed" as const };
        },
      });
      beforeRestart.start();
      await beforeRestart.admit(dmTopicCreatedUpdate());
      await beforeRestart.admit(dmRootMessageUpdate());
      await vi.waitFor(() => expect(ownerSignal).toBeDefined());
      // The decision is made once at admission and persisted with the row.
      expect(await queue.listClaims()).toMatchObject([
        { id: eventId, laneKey: "telegram:1001:topic:500", payload: { adoptedDmThreadId: 500 } },
      ]);
      const stopped = beforeRestart.stop();
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      finishDispatch();
      await stopped;
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

  it("applies a late deferred retry failure with the real error", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "4".padStart(16, "0");
      const payload = updatePayload(4);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        dispatch: async () => {
          participant.current =
            createTelegramSpooledReplayDeferredParticipant("test:late-retry") ?? undefined;
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(participant.current).toBeDefined());
      expect(await queue.listClaims()).toHaveLength(1);
      participant.current?.settle({
        kind: "failed-retryable",
        error: new Error("late provider blip"),
      });

      await vi.waitFor(async () =>
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 1, lastError: "late provider blip" },
        ]),
      );
      await monitor.stop();
    });
  });

  it.each([
    {
      name: "dispatch dedupe rollback failure",
      createError: createTelegramMessageDispatchReplayForgetError,
      reason: "dispatch-dedupe-rollback-failed",
    },
  ])("dead-letters a late deferred $name", async ({ createError, reason }) => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "5".padStart(16, "0");
      const payload = updatePayload(5);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
      const dispatch = vi.fn(async () => {
        participant.current =
          createTelegramSpooledReplayDeferredParticipant("test:late-fatal") ?? undefined;
      });
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        dispatch,
      });

      monitor.start();
      await vi.waitFor(() => expect(participant.current).toBeDefined());
      participant.current?.settle({
        kind: "failed-retryable",
        error: await createError(),
      });

      await vi.waitFor(async () =>
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([{ id: eventId, reason }]),
      );
      await monitor.waitForIdle();
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(dispatch).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });

  it.each(["completed"] as const)(
    "releases an aborted deferred claim after a late %s settlement",
    async (terminalKind) => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
          channelId: "telegram",
          accountId: "default",
          stateDir,
        });
        const updateId = terminalKind === "completed" ? 6 : 7;
        const eventId = String(updateId).padStart(16, "0");
        const payload = updatePayload(updateId);
        const laneKey = telegramSpooledUpdateLaneKey(payload.update);
        await queue.enqueue(eventId, payload, { laneKey });
        const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
        const monitor = createTelegramIngressMonitor({
          queue,
          getConfig: () => cfg,
          accountId: "default",
          dispatch: async () => {
            participant.current =
              createTelegramSpooledReplayDeferredParticipant(`test:late-${terminalKind}`) ??
              undefined;
          },
        });

        monitor.start();
        await vi.waitFor(() => expect(participant.current).toBeDefined());
        await monitor.stop();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 0 },
        ]);

        participant.current?.settle({ kind: terminalKind });
        await vi.waitFor(async () =>
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            {
              id: eventId,
              attempts: 0,
            },
          ]),
        );
        expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
        expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
      });
    },
  );

  it("uses participant settlement to own the row despite frame completion after abort", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const payload = updatePayload(8);
      const eventId = String(payload.updateId).padStart(16, "0");
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const started = deferred();
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
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

      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: eventId, attempts: 0 },
      ]);
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });

  it("uses participant adoption to own the row despite a failed frame outcome", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const payload = updatePayload(8);
      const eventId = String(payload.updateId).padStart(16, "0");
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const release = vi.spyOn(queue, "release");
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
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
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const payload = updatePayload(8);
      const eventId = String(payload.updateId).padStart(16, "0");
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const adopted = deferred();
      const finishDispatch = deferred();
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
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
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "9".padStart(16, "0");
      const payload = updatePayload(9);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        dispatch: async () => {
          participant.current =
            createTelegramSpooledReplayDeferredParticipant("test:aborted-non-retryable") ??
            undefined;
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(participant.current).toBeDefined());
      await monitor.stop();
      participant.current?.settle({
        kind: "failed-retryable",
        error: new TelegramIngressPayloadError("late invalid payload"),
      });

      await vi.waitFor(async () =>
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 0 },
        ]),
      );
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
    });
  });

  it("releases when dispatch settles only after its owner was aborted", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "8".padStart(16, "0");
      const payload = updatePayload(8);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const priorClaim = await queue.claim(eventId, { ownerId: "prior-owner" });
      if (!priorClaim) {
        throw new Error("Expected the prior Telegram ingress claim.");
      }
      const priorAttemptAt = Date.now() - 10_000;
      await queue.release(priorClaim, {
        releasedAt: priorAttemptAt,
        lastError: "previous delivery failed",
      });
      let finishDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      let ownerSignal: AbortSignal | undefined;
      const monitor = createTelegramIngressMonitor({
        queue,
        getConfig: () => cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          ownerSignal = lifecycle.abortSignal;
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:abort-before-settlement",
          );
          await dispatchGate;
          participant?.settle({ kind: "completed" });
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(ownerSignal).toBeDefined());
      const stopped = monitor.stop();
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      finishDispatch();
      await stopped;

      await vi.waitFor(async () =>
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: eventId,
            attempts: 1,
            lastAttemptAt: priorAttemptAt,
            lastError: "previous delivery failed",
          },
        ]),
      );
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });
});
