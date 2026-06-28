import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramApiOverride } from "./send.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { loadWebMedia } = getTelegramSendTestMocks();
let telegramSendModule: Awaited<ReturnType<typeof importTelegramSendModule>>;

beforeEach(async () => {
  telegramSendModule = await importTelegramSendModule();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeMockApi(overrides: Partial<TelegramApiOverride> = {}): TelegramApiOverride {
  return {
    sendVideoNote: vi.fn().mockResolvedValue({ message_id: 55, chat: { id: "200" } }),
    getChat: vi.fn().mockResolvedValue({ id: 200 }),
    sendMessage: vi.fn(),
    ...overrides,
  };
}

function mockLoadedMedia({
  buffer = Buffer.from("media"),
  contentType,
  fileName,
}: {
  buffer?: Buffer;
  contentType?: string;
  fileName?: string;
}): void {
  loadWebMedia.mockResolvedValueOnce({
    buffer,
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
  });
}

const cfg = { channels: { telegram: { botToken: "test:token" } } } as never;

describe("sendVideoNoteTelegram", () => {
  it("throws when mediaUrl is empty", async () => {
    const api = makeMockApi();
    await expect(
      telegramSendModule.sendVideoNoteTelegram("200", "  ", { cfg, api }),
    ).rejects.toThrow("mediaUrl");
  });

  it("calls sendMessageTelegram with asVideoNote option and returns result", async () => {
    // sendVideoNoteTelegram internally delegates to sendMessageTelegram with asVideoNote:true.
    // We verify that the result is returned correctly.
    const api = makeMockApi();
    mockLoadedMedia({
      buffer: Buffer.from("fake-video"),
      contentType: "video/mp4",
      fileName: "video.mp4",
    });
    const result = await telegramSendModule.sendVideoNoteTelegram(
      "200",
      "https://example.com/clip.mp4",
      {
        cfg,
        api,
      },
    );
    expect(api.sendVideoNote).toHaveBeenCalled();
    expect(result.messageId).toBeDefined();
  });
});
