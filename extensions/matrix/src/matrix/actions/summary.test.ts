import { describe, expect, it } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";

const event = {
  event_id: "$original",
  sender: "@gum:matrix.example.org",
  type: "m.room.message",
  origin_server_ts: 123,
  content: { msgtype: "m.text", body: "original text" },
};

describe("summarizeMatrixRawEvent", () => {
  it.each([
    ["photo.jpg", undefined, undefined, { kind: "image", filename: "photo.jpg" }],
    [
      "can you see this?",
      "photo.jpg",
      "can you see this?",
      {
        kind: "image",
        caption: "can you see this?",
        filename: "photo.jpg",
      },
    ],
    ["see image.png", undefined, "see image.png", { kind: "image", caption: "see image.png" }],
  ] as const)("summarizes image body %s", (body, filename, summaryBody, attachment) => {
    const summary = summarizeMatrixRawEvent({
      ...event,
      event_id: "$image",
      content: { msgtype: "m.image", body, filename },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: summaryBody,
      msgtype: "m.image",
      attachment,
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it.each([
    { name: "another sender's", sender: "@mallory:matrix.example.org", unsigned: undefined },
    { name: "redacted", sender: event.sender, unsigned: { redacted_because: {} } },
  ])("does not apply a $name bundled replacement", ({ sender, unsigned }) => {
    const summary = summarizeMatrixRawEvent({
      ...event,
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$edit",
            sender,
            unsigned,
            type: "m.room.message",
            origin_server_ts: 456,
            content: {
              "m.new_content": { msgtype: "m.text", body: "forged text" },
              "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            },
          },
        },
      },
    });

    expect(summary.body).toBe("original text");
  });
});
