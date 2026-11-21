import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMediaStory, sendDm, sendGroupMessage } from "./send.js";

vi.mock("@urbit/aura", () => ({
  scot: vi.fn(() => "mocked-ud"),
  da: {
    fromUnix: vi.fn(() => 123n),
  },
}));

describe("sendDm", () => {
  const sentAt = 1_700_000_000_000;
  const poke = vi.fn(async () => ({}));
  const sender = { api: { poke }, fromShip: "~zod" };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(sentAt);
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses aura v3 helpers for the DM id", async () => {
    const result = await sendDm({ ...sender, toShip: "~nec", text: "hi" });
    expect(da.fromUnix).toHaveBeenCalledWith(sentAt);
    expect(scot).toHaveBeenCalledWith("ud", 123n);
    expect(poke).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("~zod/mocked-ud");
    expect(result.receipt.primaryPlatformMessageId).toBe("~zod/mocked-ud");
  });

  it("passes numeric group reply ids through aura formatting", async () => {
    vi.mocked(scot).mockReturnValueOnce("~2024.1.1");

    const result = await sendGroupMessage({
      ...sender,
      hostShip: "~nec",
      channelName: "general",
      text: "threaded",
      replyToId: "1700000000000",
    });

    expect(scot).toHaveBeenCalledWith("ud", 1_700_000_000_000n);
    const memo = { content: [{ inline: ["threaded"] }], author: "~zod", sent: sentAt };
    const action = { post: { reply: { id: "~2024.1.1", action: { add: memo } } } };
    expect(poke).toHaveBeenCalledWith({
      app: "channels",
      mark: "channel-action-1",
      json: { channel: { nest: "chat/~nec/general", action } },
    });
    expect(result.receipt.threadId).toBe("~nec/general");
  });
});

describe("buildMediaStory", () => {
  const image = (src: string) => ({ block: { image: { src, height: 0, width: 0, alt: "" } } });
  it.each([
    ["caption", "#preview", [{ inline: ["caption"] }]],
    [undefined, "?token=1", []],
  ] as const)("keeps image URL suffix %s %s as an image block", (caption, suffix, prefix) => {
    const url = `https://cdn.example/image.png${suffix}`;
    expect(buildMediaStory(caption, url)).toEqual([...prefix, image(url)]);
  });

  it("keeps non-image URL paths with image-looking fragments as links", () => {
    const url = "https://cdn.example/page#preview.png";
    expect(buildMediaStory("caption", url)).toEqual([
      { inline: ["caption"] },
      { inline: [{ link: { href: url, content: url } }] },
    ]);
  });
});
import { da, scot } from "@urbit/aura";
