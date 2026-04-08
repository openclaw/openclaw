import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedQQBotAccount } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => "token"),
  sendC2CFileMessage: vi.fn(),
  sendC2CImageMessage: vi.fn(),
  sendC2CMessage: vi.fn(),
  sendC2CVideoMessage: vi.fn(),
  sendC2CVoiceMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendDmMessage: vi.fn(),
  sendGroupFileMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
  sendGroupVideoMessage: vi.fn(),
  sendGroupVoiceMessage: vi.fn(),
  sendProactiveC2CMessage: vi.fn(),
  sendProactiveGroupMessage: vi.fn(),
}));

const audioConvertMocks = vi.hoisted(() => ({
  audioFileToSilkBase64: vi.fn(async () => "c2lsaw=="),
  isAudioFile: vi.fn(() => false),
  shouldTranscodeVoice: vi.fn(() => false),
  waitForFile: vi.fn(async () => 1024),
}));

const fileUtilsMocks = vi.hoisted(() => ({
  checkFileSize: vi.fn(() => ({ ok: true })),
  downloadFile: vi.fn(),
  fileExistsAsync: vi.fn(async () => true),
  formatFileSize: vi.fn((size: number) => `${size}`),
  readFileAsync: vi.fn(async () => Buffer.from("file-data")),
}));

vi.mock("./api.js", () => apiMocks);

vi.mock("./utils/audio-convert.js", () => ({
  audioFileToSilkBase64: audioConvertMocks.audioFileToSilkBase64,
  isAudioFile: audioConvertMocks.isAudioFile,
  shouldTranscodeVoice: audioConvertMocks.shouldTranscodeVoice,
  waitForFile: audioConvertMocks.waitForFile,
}));

vi.mock("./utils/file-utils.js", () => ({
  checkFileSize: fileUtilsMocks.checkFileSize,
  downloadFile: fileUtilsMocks.downloadFile,
  fileExistsAsync: fileUtilsMocks.fileExistsAsync,
  formatFileSize: fileUtilsMocks.formatFileSize,
  readFileAsync: fileUtilsMocks.readFileAsync,
}));

vi.mock("./utils/debug-log.js", () => ({
  debugError: vi.fn(),
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

import {
  sendDocument,
  sendMedia,
  sendPhoto,
  sendVideoMsg,
  sendVoice,
  type MediaOutboundContext,
  type MediaTargetContext,
  type OutboundResult,
} from "./outbound.js";

const createdRoots: string[] = [];

const account: ResolvedQQBotAccount = {
  accountId: "default",
  enabled: true,
  appId: "app-id",
  clientSecret: "secret",
  secretSource: "config",
  markdownSupport: true,
  config: {},
};

function buildTarget(): MediaTargetContext {
  return {
    targetType: "c2c",
    targetId: "user-1",
    account,
    replyToId: "msg-1",
    logPrefix: "[qqbot:test]",
  };
}

function buildMediaContext(mediaUrl: string): MediaOutboundContext {
  return {
    to: "qqbot:c2c:user-1",
    text: "",
    account,
    mediaUrl,
    replyToId: "msg-1",
  };
}

function createOutsideFile(ext: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-outbound-security-"));
  createdRoots.push(root);
  const filePath = path.join(root, `payload${ext}`);
  fs.writeFileSync(filePath, "payload", "utf8");
  return filePath;
}

function expectBlocked(result: OutboundResult, expectedError: string): void {
  expect(result.channel).toBe("qqbot");
  expect(result.error).toBe(expectedError);
  expect(apiMocks.getAccessToken).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.clearAllMocks();
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("qqbot outbound local media path security", () => {
  it("blocks local image paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".png");
    const result = await sendPhoto(buildTarget(), outsidePath);

    expectBlocked(result, "Image path must be inside QQ Bot media storage");
  });

  it("blocks local voice paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".mp3");
    const result = await sendVoice(buildTarget(), outsidePath, undefined, false);

    expectBlocked(result, "Voice path must be inside QQ Bot media storage");
  });

  it("blocks local video paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".mp4");
    const result = await sendVideoMsg(buildTarget(), outsidePath);

    expectBlocked(result, "Video path must be inside QQ Bot media storage");
  });

  it("blocks local document paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".txt");
    const result = await sendDocument(buildTarget(), outsidePath);

    expectBlocked(result, "File path must be inside QQ Bot media storage");
  });

  it("blocks sendMedia local paths outside QQ Bot media storage", async () => {
    const outsidePath = createOutsideFile(".txt");
    const result = await sendMedia(buildMediaContext(outsidePath));

    expectBlocked(result, "Media path must be inside QQ Bot media storage");
  });
});
