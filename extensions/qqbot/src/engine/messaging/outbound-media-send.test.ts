// Qqbot tests cover outbound-media-send host-read error handling behavior.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { audioPortMock } = vi.hoisted(() => ({
  audioPortMock: {
    audioFileToSilkBase64: vi.fn(),
    isAudioFile: vi.fn(),
    shouldTranscodeVoice: vi.fn(),
    waitForFile: vi.fn(),
  },
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));

vi.mock("../adapter/index.js", () => ({
  getPlatformAdapter: () => ({ getTempDir: () => "/tmp" }),
}));

vi.mock("./outbound-audio-port.js", () => ({
  audioFileToSilkBase64: audioPortMock.audioFileToSilkBase64,
  isAudioFile: audioPortMock.isAudioFile,
  shouldTranscodeVoice: audioPortMock.shouldTranscodeVoice,
  waitForFile: audioPortMock.waitForFile,
}));

const { MockUploadDailyLimitExceededError } = vi.hoisted(() => {
  class HoistedUploadDailyLimitExceededError extends Error {
    override readonly name = "UploadDailyLimitExceededError";

    constructor(
      readonly filePath: string,
      readonly fileSize: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { MockUploadDailyLimitExceededError: HoistedUploadDailyLimitExceededError };
});

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  sendMedia: vi.fn(),
  sendText: vi.fn(),
  UploadDailyLimitExceededError: MockUploadDailyLimitExceededError,
}));

import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { resolveOutboundMediaPath, sendPhoto, sendVoice } from "./outbound-media-send.js";
import { OUTBOUND_ERROR_CODES } from "./outbound-types.js";
import { sendMedia as senderSendMedia } from "./sender.js";

const mockedLoadOutboundMediaFromUrl = vi.mocked(loadOutboundMediaFromUrl);
const mockedSenderSendMedia = vi.mocked(senderSendMedia);

let openclawHome: string;
let originalOpenClawHome: string | undefined;

function makeCtx() {
  return {
    targetType: "c2c" as const,
    targetId: "user-openid",
    account: {
      accountId: "qq-main",
      appId: "app-x",
      clientSecret: "secret-x",
      markdownSupport: false,
      config: {},
    },
    mediaAccess: {
      localRoots: ["/tmp/openclaw-sandbox"],
      workspaceDir: "/tmp/workspace",
      readFile: async () => Buffer.from("report"),
    },
    mediaLocalRoots: ["/tmp/openclaw-sandbox"],
    mediaReadFile: async () => Buffer.from("report"),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  originalOpenClawHome = process.env.OPENCLAW_HOME;
  openclawHome = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-host-read-voice-"));
  process.env.OPENCLAW_HOME = openclawHome;
  audioPortMock.audioFileToSilkBase64.mockResolvedValue(undefined);
  audioPortMock.isAudioFile.mockReturnValue(true);
  audioPortMock.shouldTranscodeVoice.mockReturnValue(false);
  audioPortMock.waitForFile.mockResolvedValue(12);
});

afterEach(async () => {
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (openclawHome) {
    await fs.rm(openclawHome, { recursive: true, force: true });
  }
});

describe("resolveOutboundMediaPath", () => {
  it("preserves authorized host /workspace paths before virtual workspace mapping", () => {
    const resolveLocalPathSpy = vi
      .spyOn(securityRuntime, "resolveLocalPathFromRootsSync")
      .mockImplementation(({ filePath }) =>
        filePath === "/workspace/attachments/report.docx"
          ? { path: "/workspace/attachments/report.docx", root: "/workspace/attachments" }
          : null,
      );
    try {
      const result = resolveOutboundMediaPath("/workspace/attachments/report.docx", "media", {
        extraLocalRoots: ["/workspace/attachments", "/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        allowMissingLocalPath: true,
      });

      expect(result).toEqual({ ok: true, mediaPath: "/workspace/attachments/report.docx" });
      expect(resolveLocalPathSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/workspace/attachments/report.docx" }),
      );
      expect(resolveLocalPathSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/tmp/agent-workspace/attachments/report.docx" }),
      );
    } finally {
      resolveLocalPathSpy.mockRestore();
    }
  });

  it("resolves relative paths only against the virtual workspace", () => {
    const resolveLocalPathSpy = vi
      .spyOn(securityRuntime, "resolveLocalPathFromRootsSync")
      .mockImplementation(({ filePath }) =>
        filePath === "/tmp/agent-workspace/report.docx"
          ? { path: "/tmp/agent-workspace/report.docx", root: "/tmp/agent-workspace" }
          : null,
      );
    try {
      const result = resolveOutboundMediaPath("report.docx", "media", {
        extraLocalRoots: ["/tmp/agent-workspace"],
        workspaceDir: "/tmp/agent-workspace",
        allowMissingLocalPath: true,
      });

      expect(result).toEqual({ ok: true, mediaPath: "/tmp/agent-workspace/report.docx" });
      expect(resolveLocalPathSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "report.docx" }),
      );
    } finally {
      resolveLocalPathSpy.mockRestore();
    }
  });
});

describe("trySendViaHostRead error handling", () => {
  it("returns OutboundResult.error when loadOutboundMediaFromUrl rejects", async () => {
    mockedLoadOutboundMediaFromUrl.mockRejectedValue(new Error("sandbox host read failed"));

    const result = await sendPhoto(makeCtx(), "/tmp/openclaw-sandbox/report.docx");

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(result.error).toContain("sandbox host read failed");
    expect(mockedSenderSendMedia).not.toHaveBeenCalled();
  });

  it("returns OutboundResult.error when senderSendMedia rejects", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockRejectedValue(new Error("qq upload quota exceeded"));

    const result = await sendPhoto(makeCtx(), "/tmp/openclaw-sandbox/report.docx");

    expect(result).toMatchObject({ channel: "qqbot", error: expect.any(String) });
    expect(result.error).toContain("qq upload quota exceeded");
  });

  it("preserves daily upload quota metadata from senderSendMedia", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockRejectedValue(
      new MockUploadDailyLimitExceededError("<buffer>", 2048, "daily quota"),
    );

    const result = await sendPhoto(makeCtx(), "report.docx");

    expect(result).toMatchObject({
      channel: "qqbot",
      errorCode: OUTBOUND_ERROR_CODES.UPLOAD_DAILY_LIMIT_EXCEEDED,
      qqBizCode: 40093002,
    });
    expect(result.error).toContain("/tmp/workspace/report.docx");
    expect(result.error).not.toContain("<buffer>");
  });

  it("maps sandbox /workspace paths before host-read media loading", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendPhoto(makeCtx(), "/workspace/report.docx");

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/report.docx",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          localRoots: ["/tmp/openclaw-sandbox", "/tmp/workspace"],
          workspaceDir: "/tmp/workspace",
        }),
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("preserves authorized host /workspace paths before virtual workspace mapping", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("report"),
      kind: "document",
      fileName: "report.docx",
      contentType: "application/octet-stream",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "media-1", timestamp: 123 });

    const result = await sendPhoto(
      {
        ...makeCtx(),
        mediaAccess: {
          localRoots: ["/workspace/attachments"],
          workspaceDir: "/tmp/agent-workspace",
          readFile: async () => Buffer.from("report"),
        },
        mediaLocalRoots: ["/workspace/attachments"],
      },
      "/workspace/attachments/report.docx",
    );

    expect(result).toMatchObject({ channel: "qqbot", messageId: "media-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/workspace/attachments/report.docx",
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          localRoots: ["/workspace/attachments", "/tmp/agent-workspace"],
          workspaceDir: "/tmp/agent-workspace",
        }),
        workspaceDir: "/tmp/agent-workspace",
      }),
    );
  });

  it("stages host-read audio before using the voice upload path", async () => {
    mockedLoadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("audio bytes"),
      kind: "audio",
      fileName: "clip.mp3",
      contentType: "audio/mpeg",
    });
    mockedSenderSendMedia.mockResolvedValue({ id: "voice-1", timestamp: 123 });

    const result = await sendVoice(makeCtx(), "clip.mp3", [".mp3"], true);

    expect(result).toMatchObject({ channel: "qqbot", messageId: "voice-1" });
    expect(mockedLoadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/workspace/clip.mp3",
      expect.objectContaining({
        maxBytes: expect.any(Number),
        mediaAccess: expect.objectContaining({
          localRoots: ["/tmp/openclaw-sandbox", "/tmp/workspace"],
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
    expect(audioPortMock.waitForFile).toHaveBeenCalledWith(expect.stringMatching(/clip-.*\.mp3$/));
    expect(mockedSenderSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "voice",
        source: { base64: Buffer.from("audio bytes").toString("base64") },
        localPathForMeta: expect.stringMatching(/clip-.*\.mp3$/),
      }),
    );
  });
});
