import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readNextcloudTalkWebhookBody } from "./monitor.js";

function createMockRequest(chunks: string[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { destroyed?: boolean; destroy: () => void };
  req.destroyed = false;
  req.headers = {};
  req.destroy = () => {
    req.destroyed = true;
  };

  void Promise.resolve().then(() => {
    for (const chunk of chunks) {
      req.emit("data", Buffer.from(chunk, "utf-8"));
      if (req.destroyed) {
        return;
      }
    }
    req.emit("end");
  });

  return req;
}

describe("readNextcloudTalkWebhookBody", () => {
  it("reads valid body within max bytes", async () => {
    const req = createMockRequest(['{"type":"Create"}']);
    const body = await readNextcloudTalkWebhookBody(req, 1024);
    expect(body).toBe('{"type":"Create"}');
  });

  it("rejects when payload exceeds max bytes", async () => {
    const req = createMockRequest(["x".repeat(300)]);
    await expect(readNextcloudTalkWebhookBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});
