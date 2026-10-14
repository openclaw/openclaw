import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessage } from "./messages.js";

const older = {
  event_id: "$older",
  sender: "@alice:example.org",
  type: "m.room.message",
  origin_server_ts: 1000,
  content: { msgtype: "m.text", body: "older" },
};

function createClient() {
  const calls = {
    getEvent: vi.fn().mockResolvedValue(older),
    resolveRoom: vi.fn().mockResolvedValue("!room:example.org"),
    getRelations: vi.fn().mockResolvedValue({ events: [], nextBatch: null }),
    doRequest: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    prepareForOneOff: vi.fn(),
  };
  return { calls, client: calls as unknown as MatrixClient };
}

describe("readMatrixMessage", () => {
  it("reads one Matrix event by id and rejects a missing id without falling back", async () => {
    const { calls, client } = createClient();
    calls.getEvent.mockImplementation(async (_roomId: string, eventId: string) => {
      if (eventId === older.event_id) {
        return {
          ...older,
          content: {
            msgtype: "m.text",
            body: "* fallback",
            "m.new_content": { msgtype: "m.image", body: "caption", filename: "photo.jpg" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
          },
        };
      }
      throw Object.assign(new Error("Event not found"), { errcode: "M_NOT_FOUND" });
    });

    await expect(
      readMatrixMessage("#room:example.org", "$older", { client }),
    ).resolves.toMatchObject({
      eventId: "$older",
      sender: "@alice:example.org",
      body: "caption",
      msgtype: "m.image",
      attachment: { kind: "image", caption: "caption", filename: "photo.jpg" },
      relatesTo: { relType: "m.replace", eventId: "$original" },
      timestamp: 1000,
    });
    expect(calls.resolveRoom).toHaveBeenCalledWith("#room:example.org");
    await expect(
      readMatrixMessage("room:!room:example.org", "$missing", { client }),
    ).rejects.toThrow("Matrix message $missing was not found in room !room:example.org.");
    expect(calls.getEvent.mock.calls).toEqual([
      ["!room:example.org", "$older"],
      ["!room:example.org", "$missing"],
    ]);
    expect(calls.doRequest).not.toHaveBeenCalled();
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.prepareForOneOff).not.toHaveBeenCalled();
    expect(calls.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", { content: {} }],
    ["redacted", { ...older, unsigned: { redacted_because: {} } }],
    ["summary failure", { ...older, content: { msgtype: "m.text", body: 123 } }],
  ])("keeps %s on the existing null/not-found path", async (_name, event) => {
    const { calls, client } = createClient();
    calls.getEvent.mockResolvedValue(event);
    await expect(readMatrixMessage("!room:example.org", "$older", { client })).rejects.toThrow(
      "Matrix message $older was not found in room !room:example.org.",
    );
    expect(calls.doRequest).not.toHaveBeenCalled();
    expect(calls.stop).not.toHaveBeenCalled();
  });

  it("projects the selected logical poll while allowing summary relation reads", async () => {
    const { calls, client } = createClient();
    calls.getEvent.mockResolvedValue({
      ...older,
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          answers: [{ id: "pizza", "m.text": "Pizza" }],
        },
      },
    });
    const summary = await readMatrixMessage("!room:example.org", "$older", { client });
    expect(summary).toMatchObject({ eventId: "$older", sender: older.sender, timestamp: 1000 });
    expect(summary.body).toContain("Lunch?");
    expect(calls.getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$older",
      "m.reference",
      undefined,
      { from: undefined },
    );
    expect(calls.doRequest).not.toHaveBeenCalled();
  });
});
