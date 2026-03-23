import { describe, expect, it } from "vitest";
import { decodeNextcloudTalkWebhookBody } from "./monitor.js";

function createReactionBody(params: { type: "Like" | "Dislike" | "Update"; content?: string }) {
  const payload = {
    type: params.type,
    actor: { type: "Person", id: "users/ada-lovelace", name: "Ada Lovelace" },
    object: {
      type: "Note",
      id: "1567",
      name: "message",
      content: "Hello world",
      mediaType: "text/plain",
    },
    target: { type: "Collection", id: "n3xtc10ud", name: "world" },
    ...(params.content !== undefined ? { content: params.content } : {}),
  };
  return JSON.stringify(payload);
}

describe("decodeNextcloudTalkWebhookBody reactions", () => {
  it("parses Like webhook payloads into added reactions", () => {
    const before = Date.now();
    const decoded = decodeNextcloudTalkWebhookBody(
      createReactionBody({
        type: "Like",
        content: "😆",
      }),
    );

    expect(decoded).toMatchObject({
      kind: "reaction",
      reaction: {
        messageId: "1567",
        roomToken: "n3xtc10ud",
        roomName: "world",
        actorId: "users/ada-lovelace",
        actorName: "Ada Lovelace",
        emoji: "😆",
        operation: "added",
      },
    });
    if (decoded.kind !== "reaction") {
      throw new Error("expected reaction decode result");
    }
    const { timestamp } = decoded.reaction;
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("parses Dislike webhook payloads into removed reactions", () => {
    const decoded = decodeNextcloudTalkWebhookBody(
      createReactionBody({
        type: "Dislike",
        content: "😆",
      }),
    );

    expect(decoded).toMatchObject({
      kind: "reaction",
      reaction: {
        emoji: "😆",
        operation: "removed",
      },
    });
  });

  it("ignores unknown webhook event types", () => {
    const decoded = decodeNextcloudTalkWebhookBody(
      createReactionBody({
        type: "Update",
        content: "😆",
      }),
    );

    expect(decoded).toEqual({ kind: "ignore" });
  });
});
