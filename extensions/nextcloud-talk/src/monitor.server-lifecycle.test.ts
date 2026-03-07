import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";

const stoppers: Array<() => Promise<void>> = [];

async function reservePort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });

  const address = blocker.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

afterEach(async () => {
  while (stoppers.length > 0) {
    const stop = stoppers.pop();
    if (stop) {
      await stop();
    }
  }
});

describe("createNextcloudTalkWebhookServer lifecycle", () => {
  it("rejects start on EADDRINUSE and can still stop cleanly", async () => {
    const reserved = await reservePort();
    stoppers.push(reserved.close);

    const { start, stop } = createNextcloudTalkWebhookServer({
      host: "127.0.0.1",
      port: reserved.port,
      path: "/nextcloud-talk-webhook",
      secret: "test-secret",
      onMessage: async () => {},
    });

    await expect(start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(stop()).resolves.toBeUndefined();
  });

  it("start/stop resolves for a normal lifecycle", async () => {
    const { start, stop } = createNextcloudTalkWebhookServer({
      host: "127.0.0.1",
      port: 0,
      path: "/nextcloud-talk-webhook",
      secret: "test-secret",
      onMessage: async () => {},
    });

    await expect(start()).resolves.toBeUndefined();
    await expect(stop()).resolves.toBeUndefined();
  });
});
