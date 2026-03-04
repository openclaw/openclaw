import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { downloadGoogleChatMedia, sendGoogleChatMessage } from "./api.js";

vi.mock("./auth.js", () => ({
  getGoogleChatAccessToken: vi.fn().mockResolvedValue("token"),
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

describe("downloadGoogleChatMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when content-length exceeds max bytes", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "50", "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });

  it("rejects when streamed payload exceeds max bytes", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      downloadGoogleChatMedia({ account, resourceName: "media/123", maxBytes: 10 }),
    ).rejects.toThrow(/max bytes/i);
  });
});

describe("sendGoogleChatMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds messageReplyOption when sending to an existing thread", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: "spaces/AAA/messages/123" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
      thread: "spaces/AAA/threads/xyz",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      text: "hello",
      thread: { name: "spaces/AAA/threads/xyz" },
    });
  });

  it("does not set messageReplyOption for non-thread sends", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: "spaces/AAA/messages/124" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await sendGoogleChatMessage({
      account,
      space: "spaces/AAA",
      text: "hello",
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("messageReplyOption=");
  });
});
