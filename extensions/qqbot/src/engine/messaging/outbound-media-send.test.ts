import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaTargetContext } from "./outbound-types.js";

const fileUtilsMocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

const senderMocks = vi.hoisted(() => ({
  sendMedia: vi.fn(),
  sendText: vi.fn(),
}));

vi.mock("../utils/file-utils.js", () => ({
  checkFileSize: () => ({ ok: true, size: 1 }),
  downloadFile: fileUtilsMocks.downloadFile,
  fileExistsAsync: vi.fn(async () => true),
  formatFileSize: (size: number) => `${size} bytes`,
  getImageMimeType: () => "image/png",
  getMaxUploadSize: () => Number.MAX_SAFE_INTEGER,
  readFileAsync: vi.fn(async () => Buffer.from("media")),
}));

vi.mock("../utils/log.js", () => ({
  debugError: logMocks.debugError,
  debugLog: logMocks.debugLog,
  debugWarn: logMocks.debugWarn,
}));

vi.mock("../utils/platform.js", () => ({
  getQQBotDataDir: (...parts: string[]) => ["qqbot-data", ...parts].join("/"),
  getQQBotMediaDir: (...parts: string[]) => ["qqbot-media", ...parts].join("/"),
  isLocalPath: (value: string) =>
    !value.startsWith("http://") && !value.startsWith("https://") && !value.startsWith("data:"),
  normalizePath: (value: string) => value,
  resolveQQBotPayloadLocalFilePath: (value: string) => value,
}));

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  sendMedia: senderMocks.sendMedia,
  sendText: senderMocks.sendText,
  UploadDailyLimitExceededError: class UploadDailyLimitExceededError extends Error {},
}));

import { sendDocument, sendPhoto, sendVideoMsg, sendVoice } from "./outbound-media-send.js";

const signedUrl =
  "https://user:pass@example.com/media/photo.png?token=download-token&safe=value#frag";
const malformedSignedUrl =
  "https://user:pass@%zz/media/photo.png?token=download-token&safe=value#frag";

const ctx: MediaTargetContext = {
  targetType: "group",
  targetId: "group-1",
  account: {
    accountId: "qq",
    appId: "app",
    clientSecret: "secret",
    config: {},
    markdownSupport: false,
  },
};

function captureOutput(resultError: string | undefined): string {
  return [
    resultError ?? "",
    ...logMocks.debugWarn.mock.calls.flat().map(String),
    ...logMocks.debugError.mock.calls.flat().map(String),
  ].join("\n");
}

function expectRedactedOutput(output: string): void {
  expect(output).toContain("https://example.com/media/photo.png");
  expect(output).not.toContain("user:pass");
  expect(output).not.toContain("download-token");
  expect(output).not.toContain("safe=value");
  expect(output).not.toContain("#frag");
}

describe("engine/messaging/outbound-media-send direct URL uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileUtilsMocks.downloadFile.mockResolvedValue(null);
    senderMocks.sendMedia.mockRejectedValue(new Error(`upload failed for ${signedUrl}`));
    senderMocks.sendText.mockResolvedValue({ id: "msg-1", timestamp: 1 });
  });

  it.each([
    ["image", () => sendPhoto(ctx, signedUrl)],
    ["voice", () => sendVoice(ctx, signedUrl)],
    ["video", () => sendVideoMsg(ctx, signedUrl)],
    ["document", () => sendDocument(ctx, signedUrl)],
  ] as const)("redacts failed %s direct-upload errors", async (_name, send) => {
    const result = await send();

    expect(result.channel).toBe("qqbot");
    expect(senderMocks.sendMedia).toHaveBeenCalled();
    expectRedactedOutput(captureOutput(result.error));
  });

  it("redacts malformed URL-like secrets in direct-upload errors", async () => {
    senderMocks.sendMedia.mockRejectedValue(new Error(`upload failed for ${malformedSignedUrl}`));

    const result = await sendPhoto(ctx, signedUrl);
    const output = captureOutput(result.error);

    expect(output).toContain("https://%zz/media/photo.png");
    expect(output).not.toContain("user:pass");
    expect(output).not.toContain("download-token");
    expect(output).not.toContain("safe=value");
    expect(output).not.toContain("#frag");
  });
});
