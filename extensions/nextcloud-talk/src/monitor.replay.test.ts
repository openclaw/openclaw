import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
import { generateNextcloudTalkSignature } from "./signature.js";

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
  shouldProcessMessage?: (
    message: Parameters<
      NonNullable<Parameters<typeof createNextcloudTalkWebhookServer>[0]["onMessage"]>
    >[0],
  ) => boolean | Promise<boolean>;
  onMessage: (message: { messageId: string }) => void | Promise<void>;
}): Promise<WebhookHarness> {
  const { server, start } = createNextcloudTalkWebhookServer({
    port: 0,
    host: "127.0.0.1",
    path: params.path,
    secret: "nextcloud-secret",
    shouldProcessMessage: params.shouldProcessMessage,
    onMessage: params.onMessage,
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
    const shouldProcessMessage = vi.fn(async (message: { messageId: string }) => {
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
    cleanupFns.push(harness.stop);

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
