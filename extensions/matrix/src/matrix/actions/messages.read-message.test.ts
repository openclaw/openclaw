import { expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessage } from "./messages.js";

const room = "!room:example.org";
const older = {
  event_id: "$older",
  sender: "@alice:example.org",
  type: "m.room.message",
  origin_server_ts: 1000,
  content: { msgtype: "m.text", body: "older" },
};

function createClient(event: unknown) {
  const calls = {
    getEvent:
      event instanceof Error ? vi.fn().mockRejectedValue(event) : vi.fn().mockResolvedValue(event),
    resolveRoom: vi.fn().mockResolvedValue(room),
    getRelations: vi.fn().mockResolvedValue({ events: [], nextBatch: null }),
    doRequest: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    prepareForOneOff: vi.fn(),
  };
  return { calls, client: calls as unknown as MatrixClient };
}

it("reads one Matrix event by id without falling back", async () => {
  const { calls, client } = createClient({
    ...older,
    content: {
      msgtype: "m.text",
      body: "* fallback",
      "m.new_content": { msgtype: "m.image", body: "caption", filename: "photo.jpg" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
    },
  });

  await expect(readMatrixMessage("#room:example.org", "$older", { client })).resolves.toMatchObject(
    {
      body: "caption",
      msgtype: "m.image",
      attachment: { kind: "image", caption: "caption", filename: "photo.jpg" },
      relatesTo: { relType: "m.replace", eventId: "$original" },
    },
  );
  expect(calls.resolveRoom).toHaveBeenCalledWith("#room:example.org");
  expect(calls.getEvent.mock.calls).toEqual([[room, "$older"]]);
  expect(calls.doRequest).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
  expect(calls.prepareForOneOff).not.toHaveBeenCalled();
  expect(calls.stop).not.toHaveBeenCalled();
});

it.each([
  ["missing", Object.assign(new Error("Event not found"), { errcode: "M_NOT_FOUND" })],
  ["malformed", { content: {} }],
  ["redacted", { ...older, unsigned: { redacted_because: {} } }],
  ["summary failure", { ...older, content: { msgtype: "m.text", body: 123 } }],
])("keeps %s on the existing null/not-found path", async (_name, event) => {
  const { calls, client } = createClient(event);
  const id = event instanceof Error ? "$missing" : "$older";
  await expect(readMatrixMessage(`room:${room}`, id, { client })).rejects.toThrow(
    `Matrix message ${id} was not found in room ${room}.`,
  );
  expect(calls.getEvent.mock.calls).toEqual([[room, id]]);
  expect(calls.doRequest).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
  expect(calls.prepareForOneOff).not.toHaveBeenCalled();
  expect(calls.stop).not.toHaveBeenCalled();
});

it("projects the selected logical poll while allowing summary relation reads", async () => {
  const { calls, client } = createClient({
    ...older,
    type: "m.poll.start",
    content: {
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        answers: [{ id: "pizza", "m.text": "Pizza" }],
      },
    },
  });
  const summary = await readMatrixMessage(room, "$older", { client });
  expect(summary).toMatchObject({ eventId: "$older", sender: older.sender, timestamp: 1000 });
  expect(summary.body).toContain("Lunch?");
  expect(calls.getRelations).toHaveBeenCalledWith(room, "$older", "m.reference", undefined, {
    from: undefined,
  });
  expect(calls.doRequest).not.toHaveBeenCalled();
});
