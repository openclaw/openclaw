import { MessageReferenceType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../internal/discord.js";
import { resolveMediaList, resolveReferencedReplyMediaList } from "./message-media.js";

const saveRemoteMediaMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMediaMock(...args),
  };
});

beforeEach(() => saveRemoteMediaMock.mockReset());

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

const attachment = {
  id: "att-reply-1",
  url: "https://cdn.discordapp.com/attachments/1/reply-image.png",
  filename: "reply-image.png",
  content_type: "image/png",
};

function asReferencedMessage(referenceType: MessageReferenceType): Message {
  return asMessage({
    messageReference: { type: referenceType },
    referencedMessage: asMessage({ attachments: [attachment] }),
  });
}

function mockDownload(filename: string) {
  saveRemoteMediaMock.mockResolvedValueOnce({ path: `/tmp/${filename}`, contentType: "image/png" });
}

describe("resolveReferencedReplyMediaList", () => {
  it("downloads referenced reply attachments", async () => {
    mockDownload("reply-image.png");
    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage(MessageReferenceType.Default),
      512,
    );

    expect(result).toEqual([
      { path: "/tmp/reply-image.png", contentType: "image/png", fileName: "reply-image.png" },
    ]);
    expect(saveRemoteMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: attachment.url,
        filePathHint: attachment.filename,
        maxBytes: 512,
      }),
    );
  });

  it("ignores forwarded references", async () => {
    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage(MessageReferenceType.Forward),
      512,
    );

    expect(result).toEqual([]);
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });
  it("merges provided ssrfPolicy with Discord CDN defaults", async () => {
    mockDownload("b.png");
    await resolveMediaList(
      asMessage({
        attachments: [{ id: "b1", url: "https://cdn.discordapp.com/b.png", filename: "b.png" }],
      }),
      1024,
      {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          hostnameAllowlist: ["assets.example.com"],
          allowedHostnames: ["assets.example.com"],
        },
      },
    );

    expect(saveRemoteMediaMock.mock.calls[0]?.[0]).toMatchObject({
      ssrfPolicy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        hostnameAllowlist: expect.arrayContaining(["assets.example.com", "cdn.discordapp.com"]),
      },
    });
  });
});
