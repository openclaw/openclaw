// Qqbot tests cover outbound-media-send host-read error handling behavior.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));

const { MockUploadDailyLimitExceededError } = vi.hoisted(() => {
  class MockUploadDailyLimitExceededError extends Error {
    override readonly name = "UploadDailyLimitExceededError";

    constructor(
      readonly filePath: string,
      readonly fileSize: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { MockUploadDailyLimitExceededError };
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
import { sendPhoto } from "./outbound-media-send.js";
import { OUTBOUND_ERROR_CODES, type OutboundResult } from "./outbound-types.js";
import { sendMedia as senderSendMedia } from "./sender.js";

const mockedLoadOutboundMediaFromUrl = vi.mocked(loadOutboundMediaFromUrl);
const mockedSenderSendMedia = vi.mocked(senderSendMedia);

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

beforeEach(() => {
  vi.clearAllMocks();
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

    const result = (await sendPhoto(makeCtx(), "report.docx")) as OutboundResult;

    expect(result).toMatchObject({
      channel: "qqbot",
      errorCode: OUTBOUND_ERROR_CODES.UPLOAD_DAILY_LIMIT_EXCEEDED,
      qqBizCode: 40093002,
    });
    expect(result.error).toContain("/tmp/workspace/report.docx");
    expect(result.error).not.toContain("<buffer>");
  });
});
