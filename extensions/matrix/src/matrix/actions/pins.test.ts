import { describe, expect, it, vi } from "vitest";
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

function createPinsClient(seedPinned: string[], events: Record<string, MatrixRawEvent> = {}) {
  let pinned = [...seedPinned];
  const getRoomStateEvent = vi.fn(async () => ({ pinned: [...pinned] }));
  const sendStateEvent = vi.fn(
    async (_roomId: string, _type: string, _key: string, payload: unknown) => {
      pinned = [...((payload as { pinned: string[] }).pinned ?? [])];
    },
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) => {
    const event = events[eventId];
    if (!event) {
      throw new Error("missing");
    }
    return event;
  });

  return {
    client: {
      getRoomStateEvent,
      sendStateEvent,
      getEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    getPinned: () => pinned,
    sendStateEvent,
  };
}

describe("matrix pins actions", () => {
  it("pins a message once even when asked twice", async () => {
    const { client, getPinned, sendStateEvent } = createPinsClient(["$a"]);

    const first = await pinMatrixMessage("!room:example.org", "$b", { client });
    const second = await pinMatrixMessage("!room:example.org", "$b", { client });

    const expected = ["$a", "$b"];
    expect([first.pinned, second.pinned, getPinned()]).toEqual([expected, expected, expected]);
    expect(sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it("unpins only the selected message id", async () => {
    const { client, getPinned } = createPinsClient(["$a", "$b", "$c"]);

    const result = await unpinMatrixMessage("!room:example.org", "$b", { client });

    expect([result.pinned, getPinned()]).toEqual([
      ["$a", "$c"],
      ["$a", "$c"],
    ]);
  });

  it("lists pinned ids and summarizes only resolvable events", async () => {
    const { client } = createPinsClient(["$a", "$missing"], { $a: message("$a", "hello") });

    const result = await listMatrixPins("!room:example.org", { client });

    expect(result).toEqual({
      pinned: ["$a", "$missing"],
      events: [
        {
          attachment: undefined,
          body: "hello",
          eventId: "$a",
          msgtype: "m.text",
          relatesTo: undefined,
          sender: "@alice:example.org",
          timestamp: 123,
        },
      ],
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

    const result = await listMatrixPins("!room:example.org", { client });

    expect(result.pinned).toEqual(["$poll", "$message"]);
    expect(result.events.map((event) => event.eventId)).toEqual(["$message"]);
    expect(getRelations).toHaveBeenCalledTimes(2);
  });
});
