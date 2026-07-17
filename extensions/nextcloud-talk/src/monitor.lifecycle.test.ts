// Nextcloud Talk tests cover webhook server lifecycle behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";

describe("createNextcloudTalkWebhookServer lifecycle", () => {
  it("rejects when the configured webhook port is already in use", async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once("error", reject);
      occupiedServer.listen(0, "127.0.0.1", resolve);
    });
    const address = occupiedServer.address() as AddressInfo;
    const webhook = createNextcloudTalkWebhookServer({
      host: "127.0.0.1",
      port: address.port,
      path: "/nextcloud-talk-webhook",
      secret: "nextcloud-secret", // pragma: allowlist secret
      onMessage: async () => {},
    });

    try {
      await expect(webhook.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      webhook.stop();
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
