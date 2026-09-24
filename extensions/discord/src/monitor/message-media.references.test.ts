import { MessageReferenceType } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../internal/discord.js";

const saveRemoteMedia = vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").saveRemoteMedia>();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, saveRemoteMedia };
});

function mockSavedImage(path: string): void {
  saveRemoteMedia.mockResolvedValueOnce({
    id: "saved-media",
    path,
    size: 5,
    contentType: "image/png",
  });
}

let resolveMediaList: typeof import("./message-media.js").resolveMediaList;
let resolveReferencedReplyMediaList: typeof import("./message-media.js").resolveReferencedReplyMediaList;

beforeAll(async () => {
  ({ resolveMediaList, resolveReferencedReplyMediaList } = await import("./message-media.js"));
});

beforeEach(() => {
  saveRemoteMedia.mockReset();
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

function asReferencedMessage(params: {
  referenceType: MessageReferenceType;
  attachments: Array<Record<string, unknown>>;
}): Message {
  return asMessage({
    messageReference: { type: params.referenceType },
    referencedMessage: asMessage({ attachments: params.attachments }),
  });
}

describe("resolveReferencedReplyMediaList", () => {
  it("downloads referenced reply attachments", async () => {
    const attachment = {
      id: "att-reply-1",
      url: "https://cdn.discordapp.com/attachments/1/reply-image.png",
      filename: "reply-image.png",
      content_type: "image/png",
    };
    mockSavedImage("/tmp/reply-image.png");

    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage({
        referenceType: MessageReferenceType.Default,
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([
      { path: "/tmp/reply-image.png", contentType: "image/png", fileName: "reply-image.png" },
    ]);
    expect(saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: attachment.url,
        filePathHint: attachment.filename,
        maxBytes: 512,
      }),
    );
  });

  it("ignores forwarded references", async () => {
    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage({
        referenceType: MessageReferenceType.Forward,
        attachments: [
          {
            id: "att-forward-1",
            url: "https://cdn.discordapp.com/attachments/1/forward.png",
            filename: "forward.png",
            content_type: "image/png",
          },
        ],
      }),
      512,
    );

    expect(result).toEqual([]);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });
});

describe("Discord media SSRF policy", () => {
  it("passes Discord CDN hostname allowlist with RFC2544 enabled", async () => {
    mockSavedImage("/tmp/a.png");

    await resolveMediaList(
      asMessage({
        attachments: [{ id: "a1", url: "https://cdn.discordapp.com/a.png", filename: "a.png" }],
      }),
      1024,
    );

    const call = saveRemoteMedia.mock.calls[0]?.[0];
    expect(call?.ssrfPolicy?.allowRfc2544BenchmarkRange).toBe(true);
    expect(call?.ssrfPolicy?.hostnameAllowlist).toEqual(
      expect.arrayContaining(["cdn.discordapp.com", "media.discordapp.net"]),
    );
  });

  it("merges provided ssrfPolicy with Discord CDN defaults", async () => {
    mockSavedImage("/tmp/b.png");

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

    const call = saveRemoteMedia.mock.calls[0]?.[0];
    expect(call?.ssrfPolicy).toMatchObject({
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
    expect(call?.ssrfPolicy?.hostnameAllowlist).toEqual(
      expect.arrayContaining(["assets.example.com", "cdn.discordapp.com"]),
    );
  });
});
