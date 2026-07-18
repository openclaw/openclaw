// Matrix tests cover summary plugin behavior.
import { describe, expect, it } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";

describe("summarizeMatrixRawEvent", () => {
  it("replaces bare media filenames with a media marker", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: undefined,
      msgtype: "m.image",
      attachment: {
        kind: "image",
        filename: "photo.jpg",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("preserves captions while marking media summaries", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "can you see this?",
        filename: "photo.jpg",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: "can you see this?",
      msgtype: "m.image",
      attachment: {
        kind: "image",
        caption: "can you see this?",
        filename: "photo.jpg",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("does not treat a sentence ending in a file extension as a bare filename", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$image",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.image",
        body: "see image.png",
      },
    });

    expect(summary).toEqual({
      eventId: "$image",
      sender: "@gum:matrix.example.org",
      body: "see image.png",
      msgtype: "m.image",
      attachment: {
        kind: "image",
        caption: "see image.png",
      },
      timestamp: 123,
      relatesTo: undefined,
    });
  });

  it("leaves text messages unchanged", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$text",
      sender: "@gum:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 123,
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    expect(summary.body).toBe("hello");
    expect(summary.attachment).toBeUndefined();
  });

  it("reads m.replace body from m.new_content when present", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$replace",
      sender: "@bot:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 200,
      content: {
        msgtype: "m.text",
        body: "* bot edited the message", // fallback text
        "m.new_content": {
          msgtype: "m.text",
          body: "hello (edited)",
        },
        "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      },
    });

    // Should use m.new_content.body, not the fallback content.body
    expect(summary.body).toBe("hello (edited)");
    expect(summary.relatesTo).toEqual({ relType: "m.replace", eventId: "$original" });
  });

  it("falls back to content.body for m.replace when m.new_content is absent", () => {
    const summary = summarizeMatrixRawEvent({
      event_id: "$replace",
      sender: "@bot:matrix.example.org",
      type: "m.room.message",
      origin_server_ts: 200,
      content: {
        msgtype: "m.text",
        body: "* bot edited the message",
        "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      },
    });

    expect(summary.body).toBe("* bot edited the message");
  });
});
