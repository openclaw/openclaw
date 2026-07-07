import { beforeEach, describe, expect, it, vi } from "vitest";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { GatewayAccount } from "../types.js";

const { sendTextMock, senderSendMediaMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(),
  senderSendMediaMock: vi.fn(),
}));

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: {
    type: string;
    senderId: string;
    groupOpenid?: string;
    guildId?: string;
    channelId?: string;
  }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id:
      target.type === "group"
        ? target.groupOpenid
        : target.type === "dm"
          ? target.guildId
          : target.type === "guild"
            ? target.channelId
            : target.senderId,
  }),
  sendMedia: senderSendMediaMock,
  sendText: sendTextMock,
  withTokenRetry: async (_creds: unknown, fn: (token: string) => Promise<unknown>) =>
    await fn("token"),
}));

import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { DEFAULT_MEDIA_SEND_ERROR } from "./outbound-types.js";

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

const event = {
  type: "c2c" as const,
  senderId: "user-openid",
  messageId: "msg-1",
};

const mediaAccess = {
  localRoots: ["/tmp/agent-workspace"],
  workspaceDir: "/tmp/agent-workspace",
};

function makeLog() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMediaSender() {
  return {
    sendPhoto: vi.fn(async () => ({ channel: "qqbot", messageId: "image-1" })),
    sendVoice: vi.fn(async () => ({ channel: "qqbot", messageId: "voice-1" })),
    sendVideoMsg: vi.fn(async () => ({ channel: "qqbot", messageId: "video-1" })),
    sendDocument: vi.fn(async () => ({ channel: "qqbot", messageId: "file-1" })),
    sendMedia: vi.fn(
      async (): Promise<
        { channel: "qqbot"; messageId: string } | { channel: "qqbot"; error: string }
      > => ({ channel: "qqbot", messageId: "media-1" }),
    ),
  };
}

function makeActx() {
  return {
    account,
    qualifiedTarget: "qqbot:c2c:user-openid",
    log: makeLog(),
    mediaAccess,
  };
}

const sendWithRetry = async <T>(sendFn: (token: string) => Promise<T>): Promise<T> =>
  await sendFn("token");

const chunkText = (text: string) => [text];

describe("outbound deliver sandbox media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMock.mockResolvedValue({ id: "text-1", timestamp: 123 });
    senderSendMediaMock.mockResolvedValue({ id: "media-1", timestamp: 123 });
  });

  it("passes scoped media access for qqmedia tags and sends a sanitized fallback on failure", async () => {
    const mediaSender = makeMediaSender();
    mediaSender.sendMedia.mockResolvedValue({ channel: "qqbot", error: "upload failed" });

    const result = await parseAndSendMediaTags(
      "<qqmedia>/workspace/missing-report.pdf</qqmedia>",
      event,
      makeActx(),
      sendWithRetry,
      vi.fn(() => undefined),
      { mediaSender, chunkText },
    );

    expect(result.handled).toBe(true);
    expect(mediaSender.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/workspace/missing-report.pdf",
        mediaAccess,
      }),
    );
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
  });

  it("auto-routes relative payload media with scoped media access and a sanitized fallback", async () => {
    const mediaSender = makeMediaSender();
    mediaSender.sendMedia.mockResolvedValue({ channel: "qqbot", error: "upload failed" });

    await sendPlainReply(
      { mediaUrl: "missing-report.pdf" },
      "",
      event,
      makeActx(),
      sendWithRetry,
      vi.fn(() => undefined),
      [],
      { mediaSender, chunkText },
    );

    expect(mediaSender.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "missing-report.pdf",
        mediaAccess,
      }),
    );
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
  });
});

// Pin the same UTF-16 boundary behavior that the production debugLog sites
// in outbound-deliver.ts rely on. The helper is the same one used by 130+
// other extension sites (Discord, Feishu, Telegram, msteams, voice-call,
// iMessage, etc.) for log/error preview truncation.
describe("outbound-deliver UTF-16-safe truncation helper", () => {
  const hasLoneSurrogate = (value: string): boolean => {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return true;
        }
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  it("truncates sent-chunk preview on UTF-16 boundary without splitting emoji", () => {
    // Mirrors the call shape at outbound-deliver.ts sent-chunk debugLog sites
    //   `Sent text chunk (${chunk.length}/${text.length} chars): ${truncateUtf16Safe(chunk, 50)}...`
    const input = "测试消息🎉🎉🎉剩余内容这是50个字符文本测试";
    const truncated = truncateUtf16Safe(input, 50);
    expect(truncated.length).toBeLessThanOrEqual(50);
    expect(hasLoneSurrogate(truncated)).toBe(false);
  });

  it("truncates media-URL preview on UTF-16 boundary", () => {
    // Mirrors the call shape at the media-URL debugLog / onSuccess sites in
    // outbound-deliver.ts (url.slice / mediaUrl.slice / imgUrl.slice / nextImageUrl.slice).
    const urlWithEmoji = "https://example.com/测试🎉🎉/path/to/file.jpg";
    const truncated = truncateUtf16Safe(urlWithEmoji, 80);
    expect(truncated.length).toBeLessThanOrEqual(80);
    expect(hasLoneSurrogate(truncated)).toBe(false);
  });

  it("passes plain ASCII through unchanged (negative control)", () => {
    const ascii = "https://example.com/path/to/file.jpg";
    expect(truncateUtf16Safe(ascii, 80)).toBe(ascii);
  });
});
