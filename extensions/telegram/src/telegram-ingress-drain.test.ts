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
import { resolveTelegramForumFlag } from "./bot/helpers.js";
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
