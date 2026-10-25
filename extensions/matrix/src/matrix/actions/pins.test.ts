import { expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { listMatrixPins, pinMatrixMessage, unpinMatrixMessage } from "./pins.js";
import type { MatrixRawEvent } from "./types.js";

function message(eventId: string, body: string, timestamp = 123) {
  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: timestamp,
    content: { msgtype: "m.text", body },
  };
}

const room = "!room:example.org";
function createPinsClient(seedPinned: string[], events: Record<string, MatrixRawEvent> = {}) {
  let pinned = [...seedPinned];
  const sendStateEvent = vi.fn(
    async (_roomId: string, _type: string, _key: string, payload: { pinned: string[] }) => {
      pinned = [...payload.pinned];
    },
  );
  return {
    client: {
      getRoomStateEvent: async () => ({ pinned: [...pinned] }),
      sendStateEvent,
      getEvent: async (_roomId: string, eventId: string) => {
        const event = events[eventId];
        if (!event) {
          throw new Error("missing");
        }
        return event;
      },
      stop: vi.fn(),
    } as unknown as MatrixClient,
    getPinned: () => pinned,
    sendStateEvent,
  };
}

it.each([
  ["pin idempotently", pinMatrixMessage, ["$a"], ["$a", "$b"], 2],
  ["unpin selectively", unpinMatrixMessage, ["$a", "$b", "$c"], ["$a", "$c"], 1],
] as const)("%s", async (_name, action, seed, expected, repetitions) => {
  const { client, getPinned, sendStateEvent } = createPinsClient([...seed]);
  for (let i = 0; i < repetitions; i++) {
    expect(await action(room, "$b", { client })).toEqual({ pinned: expected });
  }
  expect(getPinned()).toEqual(expected);
  expect(sendStateEvent).toHaveBeenCalledTimes(repetitions);
});

it("lists pinned ids and summarizes only resolvable events", async () => {
  const { client } = createPinsClient(["$a", "$missing"], { $a: message("$a", "hello") });

  expect(await listMatrixPins(room, { client })).toMatchObject({
    pinned: ["$a", "$missing"],
    events: [{ body: "hello", eventId: "$a" }],
  });
});

it("keeps other pinned messages visible when a poll repeats its pagination cursor", async () => {
  let pollPageCalls = 0;
  const getRelations = vi.fn(async () => {
    pollPageCalls += 1;
    if (pollPageCalls > 2) {
      throw new Error("test stopped unbounded Matrix poll pagination");
    }
    return { events: [], nextBatch: "stuck", prevBatch: null };
  });
  const { client } = createPinsClient(["$poll", "$message"], {
    $message: message("$message", "Still visible", 2),
    $poll: {
      ...message("$poll", "", 1),
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          answers: [{ id: "pizza", "m.text": "Pizza" }],
        },
      },
    },
  });
  Object.assign(client, { getRelations });

  const result = await listMatrixPins(room, { client });
  expect(result.pinned).toEqual(["$poll", "$message"]);
  expect(result.events.map((event) => event.eventId)).toEqual(["$message"]);
  expect(getRelations).toHaveBeenCalledTimes(2);
});
