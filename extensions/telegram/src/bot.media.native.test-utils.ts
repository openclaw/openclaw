import * as mediaRuntime from "openclaw/plugin-sdk/media-runtime";
import { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, vi } from "vitest";
import { harness } from "./bot.create-telegram-bot.native-pipeline.test-support.js";

export const telegramMediaPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
  "base64",
);
export const mediaDownload = vi.fn<typeof mediaRuntime.saveRemoteMedia>();

beforeEach(() => {
  harness.replySpy.mockResolvedValue({ text: SILENT_REPLY_TOKEN });
  mediaDownload
    .mockReset()
    .mockImplementation((params) =>
      mediaRuntime.saveMediaBuffer(
        telegramMediaPng,
        "image/png",
        "inbound",
        params.maxBytes,
        params.originalFilename,
      ),
    );
  vi.spyOn(mediaRuntime, "saveRemoteMedia").mockImplementation(mediaDownload);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
