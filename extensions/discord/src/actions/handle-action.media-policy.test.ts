import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as discordGuildActionRuntime from "../send.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const guildActionMocks = vi.hoisted(() => ({
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  hasAnyGuildPermissionDiscord: vi.fn(async () => true),
  uploadEmojiDiscord: vi.fn(async () => ({ id: "emoji-1" })),
  uploadStickerDiscord: vi.fn(async () => ({ id: "sticker-1" })),
  resolveEventCoverImage: vi.fn(async () => "data:image/png;base64,aW1n"),
  createScheduledEventDiscord: vi.fn(async () => ({ id: "event-1" })),
}));

vi.mock("../send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.js")>();
  return { ...actual, ...guildActionMocks };
});

const senderRoots = ["/srv/openclaw/workspace-sender"] as const;
const mediaReadFile = async () => Buffer.from("png");
const mediaAccess = { localRoots: senderRoots, readFile: mediaReadFile };

const cfg: OpenClawConfig = {
  channels: {
    discord: { token: "tok", actions: { emojiUploads: true, stickerUploads: true, events: true } },
  },
};
const senderContext = {
  cfg,
  requesterSenderId: "sender-1",
  senderIsOwner: false,
  toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:1" },
  mediaAccess,
  mediaLocalRoots: senderRoots,
  mediaReadFile,
};

function expectSenderMediaPolicy(opts: unknown) {
  expect(opts).toMatchObject({ mediaAccess, mediaLocalRoots: senderRoots, mediaReadFile });
}

describe("Discord guild media actions forward the sender-scoped media policy", () => {
  beforeEach(() => {
    for (const mock of Object.values(guildActionMocks)) {
      mock.mockReset();
    }
  });

  it.each([
    ["emoji-upload", { emojiName: "blob" }, discordGuildActionRuntime.uploadEmojiDiscord],
    [
      "sticker-upload",
      { stickerName: "blob", stickerDesc: "blob", stickerTags: "blob" },
      discordGuildActionRuntime.uploadStickerDiscord,
    ],
  ] as const)("passes the policy to %s loader options", async (action, params, upload) => {
    await handleDiscordMessageAction({
      ...senderContext,
      action,
      params: { guildId: "guild-1", media: "/srv/openclaw/workspace/other.png", ...params },
    });
    const call = vi.mocked(upload).mock.calls[0];
    expect(call?.[0]).toMatchObject({ mediaUrl: "/srv/openclaw/workspace/other.png" });
    expectSenderMediaPolicy(call?.[1]);
  });

  it("passes the whole policy to the event cover loader options", async () => {
    await handleDiscordMessageAction({
      ...senderContext,
      action: "event-create",
      params: {
        guildId: "guild-1",
        eventName: "launch",
        startTime: "2026-01-01T00:00:00.000Z",
        location: "online",
        eventType: "external",
        image: "/srv/openclaw/workspace/other.png",
      },
    });

    const call = vi.mocked(discordGuildActionRuntime.resolveEventCoverImage).mock.calls[0];
    expect(call?.[0]).toBe("/srv/openclaw/workspace/other.png");
    expectSenderMediaPolicy(call?.[1]);
  });
});
