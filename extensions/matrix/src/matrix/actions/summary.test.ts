// Matrix tests cover summary plugin behavior.
import { describe, expect, it } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";

describe("summarizeMatrixRawEvent", () => {
  it.each([
    {
      name: "bare media filename",
      body: "photo.jpg",
      filename: undefined,
      summaryBody: undefined,
      attachment: { kind: "image", filename: "photo.jpg" },
    },
    {
      name: "explicit caption and filename",
      body: "can you see this?",
      filename: "photo.jpg",
      summaryBody: "can you see this?",
      attachment: { kind: "image", caption: "can you see this?", filename: "photo.jpg" },
    },
    {
      name: "sentence ending in a file extension",
      body: "see image.png",
      filename: undefined,
      summaryBody: "see image.png",
      attachment: { kind: "image", caption: "see image.png" },
    },
  ])("summarizes a $name", ({ body, filename, summaryBody, attachment }) => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
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

  it("does not apply another sender's bundled replacement", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$original",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body: "original text" },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$forged",
            sender: "@mallory:matrix.example.org",
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

  it("does not apply a redacted bundled replacement", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$original",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: { msgtype: "m.text", body: "original text" },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$redacted-edit",
            sender: "@gum:matrix.example.org",
            type: "m.room.message",
            origin_server_ts: 456,
            unsigned: { redacted_because: {} },
            content: {
              "m.new_content": { msgtype: "m.text", body: "redacted text" },
              "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
            },
          },
        },
      },
    });

    expect(summary.body).toBe("original text");
  });
});
