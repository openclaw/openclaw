import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessages } from "./messages.js";

function createMessagesClient(params: {
  chunk: Array<Record<string, unknown>>;
  hydratedChunk?: Array<Record<string, unknown>>;
  pollRoot?: Record<string, unknown>;
  pollRelations?: Array<Record<string, unknown>>;
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk,
    start: "start-token",
    end: "end-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: Array<Record<string, unknown>>) =>
      (params.hydratedChunk ?? params.chunk) as any,
  );
  const getEvent = vi.fn(async () => params.pollRoot ?? null);
  const getRelations = vi.fn(async () => ({
    events: params.pollRelations ?? [],
    nextBatch: null,
    prevBatch: null,
  }));

  return {
    client: {
      doRequest,
      hydrateEvents,
      getEvent,
      getRelations,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    hydrateEvents,
    getEvent,
    getRelations,
  };
}

describe("matrix message actions", () => {
  it("includes poll snapshots when reading message history", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [
        {
          event_id: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 20,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
        {
          event_id: "$msg",
          sender: "@alice:example.org",
          type: "m.room.message",
          origin_server_ts: 10,
          content: {
            msgtype: "m.text",
            body: "hello",
          },
        },
      ],
      pollRoot: {
        event_id: "$poll",
        sender: "@alice:example.org",
        type: "m.poll.start",
        origin_server_ts: 1,
        content: {
          "m.poll.start": {
            question: { "m.text": "Favorite fruit?" },
            kind: "m.poll.disclosed",
            max_selections: 1,
            answers: [
              { id: "a1", "m.text": "Apple" },
              { id: "a2", "m.text": "Strawberry" },
            ],
          },
        },
      },
      pollRelations: [
        {
          event_id: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 20,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
      ],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client, limit: 2.9 });

    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/rooms/!room%3Aexample.org/messages"),
      expect.objectContaining({ limit: 2 }),
    );
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      {
        from: undefined,
      },
    );
    expect(result.messages).toEqual([
      expect.objectContaining({
        eventId: "$poll",
        body: expect.stringContaining("1. Apple (1 vote)"),
        msgtype: "m.text",
      }),
      expect.objectContaining({
        eventId: "$msg",
        body: "hello",
      }),
    ]);
  });

  it("dedupes multiple poll events for the same poll within one read page", async () => {
    const { client, getEvent } = createMessagesClient({
      chunk: [
        {
          event_id: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 20,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
        {
          event_id: "$poll",
          sender: "@alice:example.org",
          type: "m.poll.start",
          origin_server_ts: 1,
          content: {
            "m.poll.start": {
              question: { "m.text": "Favorite fruit?" },
              answers: [{ id: "a1", "m.text": "Apple" }],
            },
          },
        },
      ],
      pollRoot: {
        event_id: "$poll",
        sender: "@alice:example.org",
        type: "m.poll.start",
        origin_server_ts: 1,
        content: {
          "m.poll.start": {
            question: { "m.text": "Favorite fruit?" },
            answers: [{ id: "a1", "m.text": "Apple" }],
          },
        },
      },
      pollRelations: [],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        eventId: "$poll",
        body: expect.stringContaining("[Poll]"),
      }),
    );
    expect(getEvent).toHaveBeenCalledTimes(1);
  });

  it("uses hydrated history events so encrypted poll entries can be read", async () => {
    const { client, hydrateEvents } = createMessagesClient({
      chunk: [
        {
          event_id: "$enc",
          sender: "@bob:example.org",
          type: "m.room.encrypted",
          origin_server_ts: 20,
          content: {},
        },
      ],
      hydratedChunk: [
        {
          event_id: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 20,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
      ],
      pollRoot: {
        event_id: "$poll",
        sender: "@alice:example.org",
        type: "m.poll.start",
        origin_server_ts: 1,
        content: {
          "m.poll.start": {
            question: { "m.text": "Favorite fruit?" },
            answers: [{ id: "a1", "m.text": "Apple" }],
          },
        },
      },
      pollRelations: [],
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(hydrateEvents).toHaveBeenCalledWith(
      "!room:example.org",
      expect.arrayContaining([expect.objectContaining({ event_id: "$enc" })]),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.eventId).toBe("$poll");
  });
});
