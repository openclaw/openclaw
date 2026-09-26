import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { runWithTelegramSpooledReplayUpdate } from "./bot-processing-outcome.js";
import {
  apiCalls,
  createBot,
  from,
  groupCommand,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

const DEBOUNCE_MS = 4321;

function expectStopAcknowledged(threadId: number) {
  // The real shared dispatcher handles /stop before calling the model resolver.
  expect(apiCalls).toHaveBeenCalledWith(
    "sendMessage",
    expect.objectContaining({ text: "⚙️ Agent was aborted.", message_thread_id: threadId }),
  );
}

async function createDebouncedBot(native: boolean, commandSender = String(from.id)) {
  return await createBot(native, true, {
    commands: { native, text: true, allowFrom: { telegram: [commandSender] } },
    messages: { inbound: { byChannel: { telegram: DEBOUNCE_MS } } },
    channels: {
      telegram: {
        groupPolicy: "open",
        groupAllowFrom: [String(from.id)],
        groups: { "*": { requireMention: false } },
        streaming: { mode: "off" },
      },
    },
  });
}

function ordinaryMessage(text: string, threadId: number) {
  return { ...groupCommand(text, threadId), entities: [] };
}

function takeDebounceFlush(): () => void {
  const timer = vi.mocked(globalThis.setTimeout);
  const index = timer.mock.calls.findLastIndex((call) => call[1] === DEBOUNCE_MS);
  expect(index).toBeGreaterThanOrEqual(0);
  // SAFETY: This handle is the recorded return value of the real setTimeout spy.
  clearTimeout(timer.mock.results[index]?.value as ReturnType<typeof setTimeout>);
  const callback = timer.mock.calls[index]?.[0];
  if (typeof callback !== "function") {
    throw new Error("Expected the pending Telegram debounce timer");
  }
  return () => callback();
}

function createTestLifetime(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  cleanup: () => Promise<void>,
) {
  const canceled = createDeferred<never>();
  // Cancellation can precede the next wait while an update is being admitted.
  void canceled.promise.catch(() => {});
  let cleanupTask: Promise<void> | undefined;
  const close = () =>
    (cleanupTask ??= Promise.resolve()
      .then(cleanup)
      .finally(() => signal.removeEventListener("abort", onAbort)));
  const onAbort = () => {
    canceled.reject(signal.reason);
    // Vitest rejects its wrapper on timeout without unwinding the test body.
    // Start release/join now; onTestFinished still observes any cleanup failure.
    void close().catch(() => {});
  };
  onTestFinished(close);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return {
    wait: <T>(promise: Promise<T>) => Promise.race([promise, canceled.promise]),
    close,
  };
}

describe("Telegram commands during buffered message processing", () => {
  it.for([
    { native: true, command: "/status" },
    { native: false, command: "/status" },
    { native: true, command: "/btw check this" },
    { native: false, command: "/btw check this" },
  ])(
    "dispatches $command and cross-topic /stop while an ordinary run is held (native=$native)",
    async ({ native, command }, context) => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const controlEntered = createDeferred<void>();
      harness.replySpy.mockImplementation(async (ctx) => {
        if (ctx.RawBody === "ordinary run") {
          started.resolve();
          await release.promise;
        } else if (ctx.RawBody === command) {
          controlEntered.resolve();
        }
        return undefined;
      });
      const bot = await createDebouncedBot(native);
      const timer = vi.spyOn(globalThis, "setTimeout");
      const work: Promise<unknown>[] = [];
      const flushes: Array<() => void> = [];
      const lifetime = createTestLifetime(context, async () => {
        release.resolve();
        for (const flush of flushes) {
          flush();
        }
        await Promise.allSettled(work);
        timer.mockRestore();
      });
      let updateId = 5000;
      const dispatch = (message: ReturnType<typeof groupCommand>) => {
        const update = { update_id: ++updateId, message };
        const pending = runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update));
        work.push(pending);
        return pending;
      };
      const buffer = async (text: string, threadId: number) => {
        const result = await dispatch(ordinaryMessage(text, threadId));
        const participant = result.deferredWork;
        if (!participant) {
          throw new Error("Expected a durable participant for buffered Telegram input");
        }
        work.push(participant.task);
        const flush = takeDebounceFlush();
        flushes.push(flush);
        return { participant, flush };
      };

      try {
        const active = await buffer("ordinary run", 99);
        active.flush();
        await lifetime.wait(started.promise);
        const sameTopic = await buffer("same-topic follow-up", 99);
        const otherTopic = await buffer("cancel this topic", 100);

        // These updates traverse the real grammY command and message handlers. A
        // status stuck behind the active debounce flush also stalls the shared
        // control lane, including a stop targeting another topic.
        const control = dispatch(groupCommand(command, 99));
        const stop = dispatch(groupCommand("/stop", 100));
        await lifetime.wait(Promise.all([controlEntered.promise, stop]));
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody ?? "").toSorted()).toEqual(
          ["ordinary run", command].toSorted(),
        );
        await lifetime.wait(Promise.all([control, stop]));
        expect(active.participant.isSettled()).toBe(false);
        expect(sameTopic.participant.isSettled()).toBe(false);
        await expect(lifetime.wait(otherTopic.participant.task)).resolves.toEqual({
          kind: "skipped",
        });
        expect(
          harness.replySpy.mock.calls.find(([ctx]) => ctx.RawBody === command)?.[0],
        ).toMatchObject({
          CommandSource: native ? "native" : "text",
          CommandAuthorized: true,
          MessageThreadId: 99,
        });
        expectStopAcknowledged(100);

        release.resolve();
        await expect(lifetime.wait(active.participant.task)).resolves.toEqual({
          kind: "completed",
        });
        sameTopic.flush();
        await expect(lifetime.wait(sameTopic.participant.task)).resolves.toEqual({
          kind: "completed",
        });
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody ?? "").toSorted()).toEqual(
          ["ordinary run", command, "same-topic follow-up"].toSorted(),
        );
      } finally {
        await lifetime.close();
      }
    },
  );

  it("rejects unauthorized text controls without blocking an authorized stop in another topic", async (context) => {
    const guest = { ...from, id: from.id + 1, first_name: "Guest" };
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    harness.replySpy.mockImplementation(async (ctx) => {
      if (ctx.RawBody === "ordinary run") {
        started.resolve();
        await release.promise;
      } else if (ctx.RawBody === "/help" && ctx.CommandAuthorized !== true) {
        // Core admission keeps unauthorized commands behind the active run.
        // Reproduce that downstream wait if Telegram fails to reject this command.
        await release.promise;
      }
      return undefined;
    });
    const bot = await createBot(false, true, {
      commands: { native: false, text: true, allowFrom: { telegram: [String(from.id)] } },
      messages: { inbound: { byChannel: { telegram: DEBOUNCE_MS } } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: [String(from.id), String(guest.id)],
          groups: { "*": { requireMention: false } },
          streaming: { mode: "off" },
        },
      },
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const work: Promise<unknown>[] = [];
    let flush: (() => void) | undefined;
    const lifetime = createTestLifetime(context, async () => {
      release.resolve();
      flush?.();
      await Promise.allSettled(work);
      timer.mockRestore();
    });
    try {
      const update = { update_id: 6101, message: ordinaryMessage("ordinary run", 99) };
      const active = await runWithTelegramSpooledReplayUpdate(update, () =>
        bot.handleUpdate(update),
      );
      const participant = active.deferredWork;
      if (!participant) {
        throw new Error("Expected a durable participant for buffered Telegram input");
      }
      work.push(participant.task);
      flush = takeDebounceFlush();
      flush();
      await lifetime.wait(started.promise);

      const help = bot.handleUpdate({
        update_id: 6102,
        message: { ...groupCommand("/help", 99), from: guest },
      });
      work.push(help);
      const stop = bot.handleUpdate({ update_id: 6103, message: groupCommand("/stop", 100) });
      work.push(stop);
      await lifetime.wait(stop);
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["ordinary run"]);
      await lifetime.wait(Promise.all([help, stop]));
      expect(participant.isSettled()).toBe(false);
      expectStopAcknowledged(100);

      release.resolve();
      await expect(lifetime.wait(participant.task)).resolves.toEqual({ kind: "completed" });
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["ordinary run"]);
    } finally {
      await lifetime.close();
    }
  });

  it("does not let an unauthorized native stop cancel buffered input", async () => {
    const bot = await createDebouncedBot(true, "99999");
    const timer = vi.spyOn(globalThis, "setTimeout");
    let flush: (() => void) | undefined;
    let sourceWork: Promise<unknown> | undefined;
    try {
      const update = { update_id: 6001, message: ordinaryMessage("keep this input", 99) };
      const pending = await runWithTelegramSpooledReplayUpdate(update, () =>
        bot.handleUpdate(update),
      );
      const participant = pending.deferredWork;
      if (!participant) {
        throw new Error("Expected a durable participant for buffered Telegram input");
      }
      sourceWork = participant.task;
      flush = takeDebounceFlush();

      await bot.handleUpdate({ update_id: 6002, message: groupCommand("/stop", 99) });

      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(participant.isSettled()).toBe(false);
      flush();
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["keep this input"]);
    } finally {
      flush?.();
      await sourceWork;
      timer.mockRestore();
    }
  });
});
