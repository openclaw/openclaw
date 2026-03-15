import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./runtime.js", () => ({
  getNextcloudTalkRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length > 0 ? chunks : [text];
        },
      },
    },
    config: { writeConfigFile: vi.fn() },
  }),
}));

// Mock remaining imports
vi.mock("../../../src/infra/abort-signal.js", () => ({
  waitForAbortSignal: vi.fn(),
}));
vi.mock("./accounts.js", () => ({
  listNextcloudTalkAccountIds: vi.fn(() => []),
  resolveDefaultNextcloudTalkAccountId: vi.fn(() => "default"),
  resolveNextcloudTalkAccount: vi.fn(() => ({ config: {} })),
}));
vi.mock("./config-schema.js", () => ({ NextcloudTalkConfigSchema: {} }));
vi.mock("./monitor.js", () => ({ monitorNextcloudTalkProvider: vi.fn() }));
vi.mock("./normalize.js", () => ({
  looksLikeNextcloudTalkTargetId: vi.fn(),
  normalizeNextcloudTalkMessagingTarget: vi.fn(),
}));
vi.mock("./onboarding.js", () => ({ nextcloudTalkOnboardingAdapter: {} }));
vi.mock("./policy.js", () => ({ resolveNextcloudTalkGroupToolPolicy: vi.fn() }));

import { nextcloudTalkPlugin } from "./channel.js";

describe("sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageNextcloudTalkMock.mockResolvedValue({ messageId: "nc-1" });
  });

  const baseCtx = {
    to: "room-token",
    text: "",
    cfg: {} as any,
    payload: {} as any,
  };

  it("text-only delegates to sendText", async () => {
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(1);
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledWith(
      "room-token",
      "hello",
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("nextcloud-talk");
  });

  it("single media delegates to sendMedia", async () => {
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/a.png" },
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(1);
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledWith(
      "room-token",
      expect.stringContaining("Attachment: https://example.com/a.png"),
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("nextcloud-talk");
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(2);
    expect(sendMessageNextcloudTalkMock).toHaveBeenNthCalledWith(
      1,
      "room-token",
      expect.stringContaining("caption"),
      expect.objectContaining({}),
    );
    expect(sendMessageNextcloudTalkMock).toHaveBeenNthCalledWith(
      2,
      "room-token",
      expect.stringContaining("Attachment: https://example.com/b.png"),
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("nextcloud-talk");
  });

  it("empty payload returns no-op", async () => {
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "nextcloud-talk", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi
      .spyOn(nextcloudTalkPlugin.outbound! as any, "chunker")
      .mockReturnValue([]);
    const sendTextSpy = vi.spyOn(nextcloudTalkPlugin.outbound!, "sendText");
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "nextcloud-talk", messageId: "" });
    chunkerSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  it("chunking splits long text", async () => {
    // nextcloudTalkPlugin.outbound.textChunkLimit is 4000
    const longText = "A".repeat(8000);
    const result = await nextcloudTalkPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(2);
    expect(result.channel).toBe("nextcloud-talk");
  });
});
