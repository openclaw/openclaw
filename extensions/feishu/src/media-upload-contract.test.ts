import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  resolveAccount: vi.fn(),
  loadWebMedia: vi.fn(),
  fileCreate: vi.fn(),
  imageCreate: vi.fn(),
  messageCreate: vi.fn(),
  transcodeAudio: vi.fn(),
}));

vi.mock("./client.js", () => ({ createFeishuClient: mocks.createClient }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mocks.resolveAccount,
  resolveFeishuRuntimeAccount: mocks.resolveAccount,
}));
vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: () => "ou_target",
  resolveReceiveIdType: () => "open_id",
}));
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({ media: { loadWebMedia: mocks.loadWebMedia } }),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  transcodeAudioBufferToOpus: mocks.transcodeAudio,
}));

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
const pngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);
const svgImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const tiffImage = Buffer.from("49492a000800000000000000", "hex");

const account = { configured: true, accountId: "main", config: {} };

function sendMedia(options: Omit<Parameters<typeof sendMediaFeishu>[0], "cfg" | "to">) {
  return sendMediaFeishu({ cfg: {}, to: "user:ou_target", ...options });
}

function mockCallData(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0]?.[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {};
}

beforeAll(async () => {
  ({ sendMediaFeishu } = await import("./media.js"));
});

afterAll(() => {
  for (const id of ["./client.js", "./accounts.js", "./targets.js", "./runtime.js"]) {
    vi.doUnmock(id);
  }
  vi.doUnmock("openclaw/plugin-sdk/media-runtime");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAccount.mockReturnValue(account);
  mocks.createClient.mockReturnValue({
    im: {
      file: { create: mocks.fileCreate },
      image: { create: mocks.imageCreate },
      message: { create: mocks.messageCreate, reply: vi.fn() },
    },
  });
  mocks.fileCreate.mockResolvedValue({ code: 0, data: { file_key: "file_1" } });
  mocks.imageCreate.mockResolvedValue({ code: 0, data: { image_key: "image_1" } });
  mocks.messageCreate.mockResolvedValue({ code: 0, data: { message_id: "message_1" } });
});

it.each([
  ["report.pdf", "application/pdf", Buffer.from("%PDF-1.7 document"), true],
  ["diagram.png", "image/png", svgImage, false],
] as const)(
  "sends %s as a file despite voice intent or image metadata",
  async (fileName, contentType, buffer, audioAsVoice) => {
    mocks.loadWebMedia.mockResolvedValueOnce({ buffer, fileName, contentType });
    const result = await sendMedia({ mediaUrl: `https://example.com/${fileName}`, audioAsVoice });
    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mockCallData(mocks.fileCreate).file_type).toBe(audioAsVoice ? "pdf" : "stream");
    expect(mockCallData(mocks.messageCreate)).toMatchObject({ msg_type: "file" });
    expect(result.voiceIntentDegradedToFile).toBe(audioAsVoice ? true : undefined);
  },
);

it("rejects images exceeding the platform image-upload limit before contacting Feishu", async () => {
  const oversizedImage = Buffer.alloc(10 * 1024 * 1024 + 1);
  pngImage.copy(oversizedImage);
  await expect(
    sendMedia({ mediaBuffer: oversizedImage, fileName: "oversized.png" }),
  ).rejects.toThrow("Feishu image exceeds its 10485760-byte upload limit");
  expect(mocks.imageCreate).not.toHaveBeenCalled();
  expect(mocks.messageCreate).not.toHaveBeenCalled();
});

it("rejects oversized voice inputs before starting transcoding", async () => {
  mocks.resolveAccount.mockReturnValue({ ...account, config: { mediaMaxMb: 1 / (1024 * 1024) } });

  await expect(
    sendMedia({
      mediaBuffer: Buffer.from("oversized audio"),
      fileName: "voice.mp3",
      audioAsVoice: true,
    }),
  ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");
  expect(mocks.transcodeAudio).not.toHaveBeenCalled();
  expect(mocks.fileCreate).not.toHaveBeenCalled();
});

it("retains accepted image visibility when its platform identifier is missing", async () => {
  mocks.messageCreate.mockResolvedValueOnce({ code: 0, data: {} });
  const caught = await sendMedia({ mediaBuffer: tiffImage, fileName: "scan.tif" }).catch(
    (error: unknown) => error,
  );
  expect(isChannelPartialDeliveryError(caught)).toBe(true);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toHaveProperty("message", "Feishu image send failed: no message_id returned");
  expect(caught).toHaveProperty("deliveryResult", { messageIds: [], visibleReplySent: true });
  expect(mocks.messageCreate).toHaveBeenCalledOnce();
});

it("rejects empty image and file attachments before contacting Feishu", async () => {
  for (const fileName of ["empty.png", "empty.pdf"]) {
    await expect(sendMedia({ mediaBuffer: Buffer.alloc(0), fileName })).rejects.toThrow(
      "Feishu attachments cannot be empty",
    );
  }
  expect(mocks.imageCreate).not.toHaveBeenCalled();
  expect(mocks.fileCreate).not.toHaveBeenCalled();
});
