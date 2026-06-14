import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const senderSendMediaMock = vi.hoisted(() => vi.fn());
const accountToCredsMock = vi.hoisted(() =>
  vi.fn(() => ({ appId: "app", clientSecret: "secret" })),
);
const waitForFileMock = vi.hoisted(() => vi.fn(async () => 16));
const audioFileToSilkBase64Mock = vi.hoisted(() => vi.fn(async () => "silk-base64"));
const shouldTranscodeVoiceMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./sender.js", () => ({
  senderSendMedia: senderSendMediaMock,
  sendMedia: senderSendMediaMock,
  accountToCreds: accountToCredsMock,
  UploadDailyLimitExceededError: class UploadDailyLimitExceededError extends Error {},
}));

vi.mock("./outbound-audio-port.js", () => ({
  waitForFile: waitForFileMock,
  audioFileToSilkBase64: audioFileToSilkBase64Mock,
  shouldTranscodeVoice: shouldTranscodeVoiceMock,
}));

import { sendVoice } from "./outbound-media-send.js";

describe("qqbot sendVoice extraLocalRoots", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const target of tempPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("accepts trusted local voice files from mediaLocalRoots for durable sends", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-voice-root-"));
    tempPaths.push(root);
    const voicePath = path.join(root, "voice.wav");
    fs.writeFileSync(voicePath, "voice");

    senderSendMediaMock.mockResolvedValueOnce({ id: "msg-1", timestamp: 123 });

    const result = await sendVoice(
      {
        targetType: "c2c",
        targetId: "OPENID",
        account: { appId: "app", clientSecret: "secret", accountId: "default" },
        extraLocalRoots: [root],
      },
      voicePath,
      undefined,
      true,
    );

    expect(result).toMatchObject({ channel: "qqbot", messageId: "msg-1" });
    expect(senderSendMediaMock).toHaveBeenCalledTimes(1);
    expect(senderSendMediaMock.mock.calls[0]?.[0]).toMatchObject({
      kind: "voice",
      source: { base64: "silk-base64" },
      localPathForMeta: fs.realpathSync(voicePath),
    });
  });
});
