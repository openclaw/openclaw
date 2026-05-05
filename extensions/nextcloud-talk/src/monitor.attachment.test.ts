import { describe, expect, it, vi } from "vitest";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

const SECRET = "nextcloud-secret"; // pragma: allowlist secret

function createSignedRequest(objectOverrides: Record<string, unknown>) {
  const payload = {
    type: "Create",
    actor: { type: "Person", id: "alice", name: "Alice" },
    object: {
      type: "Note",
      id: "msg-1",
      name: "",
      content: "",
      mediaType: "text/plain",
      ...objectOverrides,
    },
    target: { type: "Collection", id: "room-1", name: "Room 1" },
  };
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({ body, secret: SECRET });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": "https://nextcloud.example",
    },
  };
}

describe("nextcloud-talk webhook attachment parsing", () => {
  it("parses file share rich object into displayText and mediaUrls", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-test",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const richContent = JSON.stringify({
      message: "{file}",
      parameters: {
        file: {
          type: "file",
          id: "12345",
          name: "IMG_123.jpg",
          path: "Talk/IMG_123.jpg",
          link: "https://cloud.example.com/f/12345",
          mimetype: "image/jpeg",
        },
      },
    });

    const { body, headers } = createSignedRequest({ content: richContent });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("IMG_123.jpg");
    expect(received[0].mediaUrls).toEqual(["https://cloud.example.com/f/12345"]);
  });

  it("returns undefined mediaUrls for regular text messages", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-text",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const { body, headers } = createSignedRequest({
      name: "hello world",
      content: "hello world",
    });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello world");
    expect(received[0].mediaUrls).toBeUndefined();
  });

  it("falls back to raw content for malformed JSON in object.content", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-malformed",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const { body, headers } = createSignedRequest({ content: "not json {{{" });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("not json {{{");
    expect(received[0].mediaUrls).toBeUndefined();
  });

  it("uses object.name as fallback when object.content is empty", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-name-fallback",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const { body, headers } = createSignedRequest({
      content: "",
      name: "fallback text",
    });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("fallback text");
    expect(received[0].mediaUrls).toBeUndefined();
  });

  it("resolves displayText for non-file rich objects (mentions) without populating mediaUrls", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-mention",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const mentionContent = JSON.stringify({
      message: "{mention} joined the room",
      parameters: {
        mention: {
          type: "user",
          id: "alice",
          name: "Alice",
        },
      },
    });

    const { body, headers } = createSignedRequest({ content: mentionContent });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("Alice joined the room");
    expect(received[0].mediaUrls).toBeUndefined();
  });

  it("rejects non-http(s) URLs in file parameters", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-bad-url",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const maliciousContent = JSON.stringify({
      message: "{file}",
      parameters: {
        file: {
          type: "file",
          id: "1",
          name: "passwd",
          path: "Talk/passwd",
          link: "file:///etc/passwd",
          mimetype: "text/plain",
        },
      },
    });

    const { body, headers } = createSignedRequest({ content: maliciousContent });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    // displayText still resolves but malicious URL is not in mediaUrls
    expect(received[0].text).toBe("passwd");
    expect(received[0].mediaUrls).toBeUndefined();
  });

  it("handles multiple file attachments in a single message", async () => {
    const received: NextcloudTalkInboundMessage[] = [];
    const harness = await startWebhookServer({
      path: "/attachment-multi",
      onMessage: async (msg) => {
        received.push(msg);
      },
    });

    const multiContent = JSON.stringify({
      message: "{file1} and {file2}",
      parameters: {
        file1: {
          type: "file",
          id: "1",
          name: "photo1.jpg",
          path: "Talk/photo1.jpg",
          link: "https://cloud.example.com/f/1",
          mimetype: "image/jpeg",
        },
        file2: {
          type: "file",
          id: "2",
          name: "photo2.jpg",
          path: "Talk/photo2.jpg",
          link: "https://cloud.example.com/f/2",
          mimetype: "image/jpeg",
        },
      },
    });

    const { body, headers } = createSignedRequest({ content: multiContent });
    const res = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("photo1.jpg and photo2.jpg");
    expect(received[0].mediaUrls).toEqual([
      "https://cloud.example.com/f/1",
      "https://cloud.example.com/f/2",
    ]);
  });
});
