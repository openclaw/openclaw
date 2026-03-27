import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockIsJidGroup,
  mockNormalizeMessageContent,
} from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("fake-media-data")),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
  };
});

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return {
    ...actual,
    DisconnectReason: actual.DisconnectReason ?? { loggedOut: 401 },
    extractMessageContent: vi.fn((message: MockMessageInput) => mockExtractMessageContent(message)),
    getContentType: vi.fn((message: MockMessageInput) => mockGetContentType(message)),
    isJidGroup: vi.fn((jid: string | undefined | null) => mockIsJidGroup(jid)),
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
};

async function expectMimetype(message: Record<string, unknown>, expected: string) {
  const result = await downloadInboundMedia({ message } as never, mockSock as never);
  expect(result).toBeDefined();
  expect(result?.mimetype).toBe(expected);
}

describe("downloadInboundMedia", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ downloadInboundMedia } = await import("./media.js"));
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
    mockSock.updateMediaMessage.mockClear();
  });

  it("returns undefined for messages without media", async () => {
    const msg = { message: { conversation: "hello" } } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toBeUndefined();
  });

  it("uses explicit mimetype from audioMessage when present", async () => {
    await expectMimetype({ audioMessage: { mimetype: "audio/mp4", ptt: true } }, "audio/mp4");
  });

  it.each([
    { name: "voice messages without explicit MIME", audioMessage: { ptt: true } },
    { name: "audio messages without MIME or ptt flag", audioMessage: {} },
  ])("defaults to audio/ogg for $name", async ({ audioMessage }) => {
    await expectMimetype({ audioMessage }, "audio/ogg; codecs=opus");
  });

  it("uses explicit mimetype from imageMessage when present", async () => {
    await expectMimetype({ imageMessage: { mimetype: "image/png" } }, "image/png");
  });

  it.each([
    { name: "image", message: { imageMessage: {} }, mimetype: "image/jpeg" },
    { name: "video", message: { videoMessage: {} }, mimetype: "video/mp4" },
    { name: "sticker", message: { stickerMessage: {} }, mimetype: "image/webp" },
  ])("defaults MIME for $name messages without explicit MIME", async ({ message, mimetype }) => {
    await expectMimetype(message, mimetype);
  });

  it("preserves fileName from document messages", async () => {
    const msg = {
      message: {
        documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" },
      },
    } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toBeDefined();
    expect(result?.mimetype).toBe("application/pdf");
    expect(result?.fileName).toBe("report.pdf");
  });
});
