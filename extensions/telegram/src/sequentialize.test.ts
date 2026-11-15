import type { Chat } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it } from "vitest";
import { createTelegramSequentializer } from "./sequentialize.js";

const chat: Chat.SupergroupChat = { id: -1001, type: "supergroup", title: "Q", is_forum: true };

function update(id: number, messageId: number, topic: number | "reaction") {
  const base = { chat, message_id: messageId, date: 1 };
  return {
    id,
    context:
      topic === "reaction"
        ? { update: { message_reaction: base } }
        : {
            message: {
              ...base,
              message_thread_id: topic,
              is_topic_message: true,
              text: "message",
              from: { id: 1, is_bot: false, first_name: "Ada" },
            },
          },
  };
}

function createSequencer(handler: (id: number) => Promise<void>) {
  const started: number[] = [];
  const sequentialize = createTelegramSequentializer();
  const run = ({ id, context }: ReturnType<typeof update>) =>
    sequentialize(context, () => {
      started.push(id);
      return handler(id);
    });
  return { started, run };
}

it("reserves overlapping lanes in FIFO order without blocking other topics or deleting newer tails", async () => {
  const firstGate = createDeferred<void>();
  const secondGate = createDeferred<void>();
  const secondStarted = createDeferred<void>();
  const { started, run } = createSequencer(async (id) => {
    if (id === 2) {
      secondStarted.resolve();
    }
    return id === 1 ? firstGate.promise : id === 2 ? secondGate.promise : undefined;
  });
  const first = run(update(1, 77, 9));
  const second = run(update(2, 78, 9));
  const queuedReaction = run(update(3, 78, "reaction"));
  const unrelated = run(update(4, 79, 10));
  const runs = [first, second, queuedReaction, unrelated];

  try {
    await unrelated;
    expect(started).toEqual([1, 4]);

    firstGate.resolve();
    await Promise.all([first, secondStarted.promise]);
    const third = run(update(5, 80, 9));
    const anotherTopic = run(update(6, 81, 10));
    runs.push(third, anotherTopic);
    await anotherTopic;
    expect(started).toEqual([1, 4, 2, 6]);

    secondGate.resolve();
    await Promise.all(runs);
    expect(started.slice(4).toSorted((left, right) => left - right)).toEqual([3, 5]);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled(runs);
  }
});

it("recovers a failed reaction without releasing other lanes", async () => {
  const gate = createDeferred<void>();
  const error = new Error("reaction failed");
  const { started, run } = createSequencer((id) => {
    if (id !== 2) {
      return id === 1 ? gate.promise : Promise.resolve();
    }
    throw error;
  });
  const topic = run(update(1, 76, 9));
  const failedReaction = run(update(2, 77, "reaction"));
  const rejection = expect(failedReaction).rejects.toBe(error);
  const joined = run(update(3, 77, 9));
  const runs = [topic, failedReaction, joined];

  try {
    await rejection;
    await run(update(4, 78, 10));
    expect(started).toEqual([1, 2, 4]);

    gate.resolve();
    await Promise.all([topic, joined]);
    expect(started).toEqual([1, 2, 4, 3]);
    await run(update(5, 77, 9));
    expect(started).toEqual([1, 2, 4, 3, 5]);
  } finally {
    gate.resolve();
    await Promise.allSettled(runs);
  }
});
