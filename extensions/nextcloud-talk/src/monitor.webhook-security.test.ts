import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
import { generateNextcloudTalkSignature } from "./signature.js";

const SECRET = "test-secret";
const WEBHOOK_PATH = "/nextcloud-talk-webhook";

const VALID_PAYLOAD = {
  type: "Create",
  actor: { type: "Person", id: "user-1", name: "Alice" },
  object: { type: "Note", id: "message-1", content: "hello" },
  target: { type: "Room", id: "room-1", name: "General" },
};

describe("createNextcloudTalkWebhookServer replay protection", () => {
  it("processes a valid signed payload only once when replayed", async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: SECRET,
    });

    const onMessage = vi.fn(async () => {});
    const serverState = createNextcloudTalkWebhookServer({
      port: 0,
      host: "127.0.0.1",
      path: WEBHOOK_PATH,
      secret: SECRET,
      onMessage,
    });

    await serverState.start();
    const address = serverState.server.address() as AddressInfo | null;
    if (!address) {
      serverState.stop();
      throw new Error("missing server address");
    }

    try {
      const url = `http://127.0.0.1:${address.port}${WEBHOOK_PATH}`;
      const headers = {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      };

      const first = await fetch(url, { method: "POST", headers, body });
      const second = await fetch(url, { method: "POST", headers, body });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      serverState.stop();
    }
  });
});
