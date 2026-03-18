/**
 * Live integration test: fire real signed NC Talk webhook payloads at the
 * patched server and assert the full parsing pipeline works end-to-end.
 */
import { describe, expect, it } from "vitest";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

const SECRET = "test-secret-live"; // pragma: allowlist secret

function signed(objectOverrides: Record<string, unknown>) {
  const payload = {
    type: "Create",
    actor: { type: "Person", id: "testuser", name: "Alice" },
    object: {
      type: "Note",
      id: "msg-1",
      name: "",
      content: "",
      mediaType: "text/plain",
      ...objectOverrides,
    },
    target: { type: "Collection", id: "room-abc", name: "Test Room" },
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

describe("live integration: NC Talk attachment parsing pipeline", () => {
  it("file share: text=filename, mediaUrls=[https link]", async () => {
    const msgs: NextcloudTalkInboundMessage[] = [];
    const h = await startWebhookServer({
      path: "/live-1",
      secret: SECRET,
      onMessage: async (m) => msgs.push(m),
    });
    const content = JSON.stringify({
      message: "{file}",
      parameters: {
        file: {
          type: "file",
          id: "42",
          name: "chart.png",
          path: "Talk/chart.png",
          link: "https://cloud.example.com/f/42",
          mimetype: "image/png",
        },
      },
    });
    const { body, headers } = signed({ content });
    await fetch(h.webhookUrl, { method: "POST", headers, body });
    expect(msgs[0].text).toBe("chart.png");
    expect(msgs[0].mediaUrls).toEqual(["https://cloud.example.com/f/42"]);
  });

  it("mention: text resolved, mediaUrls=undefined", async () => {
    const msgs: NextcloudTalkInboundMessage[] = [];
    const h = await startWebhookServer({
      path: "/live-2",
      secret: SECRET,
      onMessage: async (m) => msgs.push(m),
    });
    const content = JSON.stringify({
      message: "{mention} sent a message",
      parameters: { mention: { type: "user", id: "testuser", name: "Alice" } },
    });
    const { body, headers } = signed({ content });
    await fetch(h.webhookUrl, { method: "POST", headers, body });
    expect(msgs[0].text).toBe("Alice sent a message");
    expect(msgs[0].mediaUrls).toBeUndefined();
  });

  it("plain text: no regression, mediaUrls=undefined", async () => {
    const msgs: NextcloudTalkInboundMessage[] = [];
    const h = await startWebhookServer({
      path: "/live-3",
      secret: SECRET,
      onMessage: async (m) => msgs.push(m),
    });
    const { body, headers } = signed({ content: "Hello from Alice", name: "Hello from Alice" });
    await fetch(h.webhookUrl, { method: "POST", headers, body });
    expect(msgs[0].text).toBe("Hello from Alice");
    expect(msgs[0].mediaUrls).toBeUndefined();
  });

  it("malicious file:// URL: text resolved, mediaUrls=undefined", async () => {
    const msgs: NextcloudTalkInboundMessage[] = [];
    const h = await startWebhookServer({
      path: "/live-4",
      secret: SECRET,
      onMessage: async (m) => msgs.push(m),
    });
    const content = JSON.stringify({
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
    const { body, headers } = signed({ content });
    await fetch(h.webhookUrl, { method: "POST", headers, body });
    expect(msgs[0].text).toBe("passwd");
    expect(msgs[0].mediaUrls).toBeUndefined();
  });

  it("multi-file: both links in mediaUrls, text has both names", async () => {
    const msgs: NextcloudTalkInboundMessage[] = [];
    const h = await startWebhookServer({
      path: "/live-5",
      secret: SECRET,
      onMessage: async (m) => msgs.push(m),
    });
    const content = JSON.stringify({
      message: "{f1} and {f2}",
      parameters: {
        f1: {
          type: "file",
          id: "1",
          name: "photo1.jpg",
          path: "Talk/photo1.jpg",
          link: "https://cloud.example.com/f/1",
          mimetype: "image/jpeg",
        },
        f2: {
          type: "file",
          id: "2",
          name: "photo2.jpg",
          path: "Talk/photo2.jpg",
          link: "https://cloud.example.com/f/2",
          mimetype: "image/jpeg",
        },
      },
    });
    const { body, headers } = signed({ content });
    await fetch(h.webhookUrl, { method: "POST", headers, body });
    expect(msgs[0].text).toBe("photo1.jpg and photo2.jpg");
    expect(msgs[0].mediaUrls).toEqual([
      "https://cloud.example.com/f/1",
      "https://cloud.example.com/f/2",
    ]);
  });
});
