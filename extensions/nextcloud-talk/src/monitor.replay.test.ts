import { describe, expect, it, vi } from "vitest";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

function createSignedRequest(body: string): { random: string; signature: string } {
  return generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret",
  });
}

describe("createNextcloudTalkWebhookServer replay handling", () => {
  it("acknowledges replayed requests and skips onMessage side effects", async () => {
    const seen = new Set<string>();
    const onMessage = vi.fn(async () => {});
    const shouldProcessMessage = vi.fn(async (message: NextcloudTalkInboundMessage) => {
      if (seen.has(message.messageId)) {
        return false;
      }
      seen.add(message.messageId);
      return true;
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-replay",
      shouldProcessMessage,
      onMessage,
    });

    const payload = {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hello",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "room-1", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = createSignedRequest(body);
    const headers = {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": "https://nextcloud.example",
    };

    const first = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });
    const second = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(shouldProcessMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
