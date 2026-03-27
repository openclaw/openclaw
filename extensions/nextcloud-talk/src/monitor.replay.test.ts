import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockIncomingRequest } from "../../../test/helpers/mock-incoming-request.js";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "../runtime-api.js";
import {
  clearNextcloudTalkWebhookSecurityStateForTest,
  readNextcloudTalkWebhookBody,
} from "./monitor.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

beforeEach(() => {
  clearNextcloudTalkWebhookSecurityStateForTest();
});

describe("readNextcloudTalkWebhookBody", () => {
  it("reads valid body within max bytes", async () => {
    const req = createMockIncomingRequest(['{"type":"Create"}']);
    const body = await readNextcloudTalkWebhookBody(req, 1024);
    expect(body).toBe('{"type":"Create"}');
  });

  it("rejects when payload exceeds max bytes", async () => {
    const req = createMockIncomingRequest(["x".repeat(300)]);
    await expect(readNextcloudTalkWebhookBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});

describe("createNextcloudTalkWebhookServer auth order", () => {
  it("rejects missing signature headers before reading request body", async () => {
    const readBody = vi.fn(async () => {
      throw new Error("should not be called for missing signature headers");
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-order",
      maxBodyBytes: 128,
      readBody,
      onMessage: vi.fn(),
    });

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

describe("createNextcloudTalkWebhookServer backend allowlist", () => {
  it("rejects requests from unexpected backend origins", async () => {
    const onMessage = vi.fn(async () => {});
    const harness = await startWebhookServer({
      path: "/nextcloud-backend-check",
      isBackendAllowed: (backend) => backend === "https://nextcloud.expected",
      onMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest({
      backend: "https://nextcloud.unexpected",
    });
    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

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

    const { body, headers } = createSignedCreateMessageRequest();

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

describe("createNextcloudTalkWebhookServer payload validation", () => {
  it("rejects malformed webhook payloads after signature verification", async () => {
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
      target: { type: "Collection", id: "", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-invalid-payload",
      onMessage: vi.fn(),
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});

describe("createNextcloudTalkWebhookServer auth rate limiting", () => {
  it("rate limits repeated invalid signature attempts from the same source", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-auth-rate-limit",
      onMessage: vi.fn(),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const invalidHeaders = {
      ...headers,
      "x-nextcloud-talk-signature": "invalid-signature",
    };

    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; attempt += 1) {
      lastResponse = await fetch(harness.webhookUrl, {
        method: "POST",
        headers: invalidHeaders,
        body,
      });
    }

    expect(lastResponse).toBeDefined();
    expect(lastResponse?.status).toBe(429);
    expect(await lastResponse?.text()).toBe("Too Many Requests");
  });
});
