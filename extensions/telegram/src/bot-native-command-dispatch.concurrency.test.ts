import assert from "node:assert/strict";
import type { User } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { runWithTelegramSpooledReplayUpdate } from "./bot-processing-outcome.js";
import {
  apiCalls,
  createBot,
  from,
  groupCommand,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { createTestLifetime } from "./test-lifetime.test-support.js";

const DEBOUNCE_MS = 4321;
const bodies = () => harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody);
async function createDebouncedBot(
  native: boolean,
  commandSender = String(from.id),
  groupAllowFrom = [String(from.id)],
) {
  return await createBot(native, true, {
    commands: { native, text: true, allowFrom: { telegram: [commandSender] } },
    messages: { inbound: { byChannel: { telegram: DEBOUNCE_MS } } },
    channels: {
      telegram: {
        groupPolicy: "open",
        groupAllowFrom,
        groups: { "*": { requireMention: false } },
        streaming: { mode: "off" },
      },
    },
  });
}

function takeDebounceFlush(): () => void {
  const timer = vi.mocked(globalThis.setTimeout);
  const index = timer.mock.calls.findLastIndex((call) => call[1] === DEBOUNCE_MS);
  expect(index).toBeGreaterThanOrEqual(0);
  // SAFETY: This handle is the recorded return value of the real setTimeout spy.
  clearTimeout(timer.mock.results[index]?.value as ReturnType<typeof setTimeout>);
  const callback = timer.mock.calls[index]?.[0];
  assert(typeof callback === "function", "Expected the pending Telegram debounce timer");
  return () => callback();
}

function bufferedHarness(
  context: Parameters<typeof createTestLifetime>[0],
  bot: Awaited<ReturnType<typeof createBot>>,
  release = createDeferred<void>(),
) {
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
  const dispatch = (
    message: Omit<ReturnType<typeof groupCommand>, "from"> & { from: User },
    spooled = false,
  ) => {
    const update = { update_id: ++updateId, message };
    const pending = spooled
      ? runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update))
      : bot.handleUpdate(update);
    work.push(pending);
    return pending.then(() => undefined);
  };
  const buffer = async (text: string, threadId: number) => {
    const update = {
      update_id: ++updateId,
      message: { ...groupCommand(text, threadId), entities: [] },
    };
    const pending = runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update));
    work.push(pending);
    const participant = (await pending).deferredWork;
    assert(participant, "Expected a durable participant for buffered Telegram input");
    work.push(participant.task);
    const flush = takeDebounceFlush();
    flushes.push(flush);
    return {
      participant,
      flush,
      settled: (kind: "completed" | "skipped") =>
        expect(lifetime.wait(participant.task)).resolves.toEqual({ kind }),
    };
  };
  return { lifetime, dispatch, buffer, wait: lifetime.wait };
}

describe("Telegram commands during buffered message processing", () => {
  it.for([
    { native: true, command: "/status", authorized: true },
    { native: false, command: "/btw check this", authorized: true },
    { native: false, command: "/help", authorized: false },
  ])(
    "$command leaves cross-topic stop unblocked (authorized=$authorized, native=$native)",
    async ({ native, command, authorized }, context) => {
      const guest = { ...from, id: from.id + 1, first_name: "Guest" };
      const controlEntered = createDeferred<void>();
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      harness.replySpy.mockImplementation(async (ctx) => {
        if (ctx.RawBody === "ordinary run") {
          started.resolve();
          await release.promise;
        } else if (ctx.RawBody === command) {
          if (authorized) {
            controlEntered.resolve();
          } else if (ctx.CommandAuthorized !== true) {
            // Core admission blocks a guest control if Telegram fails to reject it.
            await release.promise;
          }
        }
      });
      const bot = await createDebouncedBot(
        native,
        String(from.id),
        authorized ? [String(from.id)] : [String(from.id), String(guest.id)],
      );
      const { lifetime, dispatch, buffer, wait } = bufferedHarness(context, bot, release);
      try {
        const active = await buffer("ordinary run", 99);
        active.flush();
        await wait(started.promise);
        const sameTopic = authorized ? await buffer("same-topic follow-up", 99) : undefined;
        const otherTopic = authorized ? await buffer("cancel this topic", 100) : undefined;
        const control = dispatch(
          { ...groupCommand(command, 99), from: authorized ? from : guest },
          authorized,
        );
        const stop = dispatch(groupCommand("/stop", 100), authorized);
        await wait(authorized ? Promise.all([controlEntered.promise, stop]) : stop);
        const expected = authorized ? ["ordinary run", command] : ["ordinary run"];
        expect(bodies().toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
          expected.toSorted((a, b) => a.localeCompare(b)),
        );
        await wait(Promise.all([control, stop]));
        expect(active.participant.isSettled()).toBe(false);
        if (sameTopic && otherTopic) {
          expect(sameTopic.participant.isSettled()).toBe(false);
          await otherTopic.settled("skipped");
          expect(
            harness.replySpy.mock.calls.find(([ctx]) => ctx.RawBody === command)?.[0],
          ).toMatchObject({
            CommandSource: native ? "native" : "text",
            CommandAuthorized: true,
            MessageThreadId: 99,
          });
        }
        // /stop is acknowledged by the real shared dispatcher, not the model resolver.
        expect(apiCalls).toHaveBeenCalledWith(
          "sendMessage",
          expect.objectContaining({ text: "⚙️ Agent was aborted.", message_thread_id: 100 }),
        );
        release.resolve();
        await active.settled("completed");
        if (sameTopic) {
          sameTopic.flush();
          await sameTopic.settled("completed");
          expected.push("same-topic follow-up");
        }
        expect(bodies().toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
          expected.toSorted((a, b) => a.localeCompare(b)),
        );
      } finally {
        await lifetime.close();
      }
    },
  );

  it("does not let an unauthorized native stop cancel buffered input", async (context) => {
    const bot = await createDebouncedBot(true, "99999");
    const { lifetime, buffer } = bufferedHarness(context, bot);
    try {
      const { participant, flush } = await buffer("keep this input", 99);

      await bot.handleUpdate({ update_id: 6002, message: groupCommand("/stop", 99) });

      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(participant.isSettled()).toBe(false);
      flush();
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(bodies()).toEqual(["keep this input"]);
    } finally {
      await lifetime.close();
    }
  });
});
