import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";

type WebhookHarness = {
  webhookUrl: string;
  stop: () => Promise<void>;
};

const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const cleanup = cleanupFns.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

async function startWebhookServer(params: {
  path: string;
  maxBodyBytes: number;
  readBody?: (req: import("node:http").IncomingMessage, maxBodyBytes: number) => Promise<string>;
}): Promise<WebhookHarness> {
  const { server, start } = createNextcloudTalkWebhookServer({
    port: 0,
    host: "127.0.0.1",
    path: params.path,
    secret: "nextcloud-secret",
    maxBodyBytes: params.maxBodyBytes,
    readBody: params.readBody,
    onMessage: vi.fn(),
  });
  await start();
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  return {
    webhookUrl: `http://127.0.0.1:${address.port}${params.path}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("createNextcloudTalkWebhookServer auth order", () => {
  it("rejects missing signature headers before reading request body", async () => {
    const readBody = vi.fn(async () => {
      throw new Error("should not be called for missing signature headers");
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-order",
      maxBodyBytes: 128,
      readBody,
    });
    cleanupFns.push(harness.stop);

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing signature headers" });
    expect(readBody).not.toHaveBeenCalled();
  });
});
