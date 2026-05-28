import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEAKEASY_VOICE_BUTTON_LABEL,
  SPEAKEASY_VOICE_CALLBACK_PREFIX,
  loadSpeakeasyCache,
  markSpeakeasyVoiceGenerated,
  resolveSpeakeasyCachedText,
  shouldAllowSpeakeasyVoiceGeneration,
  withSpeakeasyVoiceButton,
} from "./speakeasy-voice.js";

async function withSpeakeasyWorkspace<T>(
  fn: (params: {
    workspaceDir: string;
    cfg: { agents: { defaults: { workspace: string } } };
  }) => Promise<T>,
) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-speakeasy-test-"));
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  await mkdir(path.join(workspaceDir, "state"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "config", "speakeasy-chats.json"),
    JSON.stringify({ enabled: ["telegram:123"] }),
  );
  try {
    return await fn({
      workspaceDir,
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("speakeasy voice button", () => {
  it("adds one cached callback button to eligible enabled DM text replies", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const reply = withSpeakeasyVoiceButton({
        reply: { text: "This reply is long enough to qualify for on-demand voice playback." },
        cfg,
        chatId: "123",
        isGroup: false,
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };

      expect(reply.channelData?.telegram?.buttons).toEqual([
        [
          {
            text: SPEAKEASY_VOICE_BUTTON_LABEL,
            callback_data: expect.stringMatching(/^tts:speakeasy:/),
          },
        ],
      ]);

      const callbackData = reply.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";
      const cache = loadSpeakeasyCache(cfg);
      expect(resolveSpeakeasyCachedText({ cfg, cache, data: callbackData, chatId: "123" })).toEqual(
        {
          ok: true,
          text: "This reply is long enough to qualify for on-demand voice playback.",
        },
      );
    });
  });

  it("does not alter disabled, group, short, media, voice, or already-Speakeasy replies", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const text = "This reply is long enough to qualify for on-demand voice playback.";
      expect(withSpeakeasyVoiceButton({ reply: { text }, cfg, chatId: "999" })).toEqual({
        text,
      });
      expect(
        withSpeakeasyVoiceButton({ reply: { text }, cfg, chatId: "123", isGroup: true }),
      ).toEqual({ text });
      expect(withSpeakeasyVoiceButton({ reply: { text: "short" }, cfg, chatId: "123" })).toEqual({
        text: "short",
      });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text, mediaUrl: "/tmp/audio.mp3" },
          cfg,
          chatId: "123",
        }),
      ).toEqual({ text, mediaUrl: "/tmp/audio.mp3" });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text, audioAsVoice: true },
          cfg,
          chatId: "123",
        }),
      ).toEqual({ text, audioAsVoice: true });
      const existingReply = {
        text,
        channelData: {
          telegram: {
            buttons: [
              [
                {
                  text: SPEAKEASY_VOICE_BUTTON_LABEL,
                  callback_data: `${SPEAKEASY_VOICE_CALLBACK_PREFIX}abc`,
                },
              ],
            ],
          },
        },
      };
      expect(withSpeakeasyVoiceButton({ reply: existingReply, cfg, chatId: "123" })).toBe(
        existingReply,
      );
    });
  });

  it("expires stale cached callbacks and enforces the daily generation cap", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const cache = loadSpeakeasyCache(cfg);
      cache.entries.old = {
        chatId: "123",
        text: "Expired text",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      };

      expect(
        resolveSpeakeasyCachedText({
          cfg,
          cache,
          data: `${SPEAKEASY_VOICE_CALLBACK_PREFIX}old`,
          chatId: "123",
        }),
      ).toEqual({ ok: false, reason: "expired" });

      for (let index = 0; index < 50; index += 1) {
        markSpeakeasyVoiceGenerated({ cache, chatId: "123" });
      }
      expect(shouldAllowSpeakeasyVoiceGeneration({ cache, chatId: "123" })).toBe(false);
      expect(shouldAllowSpeakeasyVoiceGeneration({ cache, chatId: "999" })).toBe(true);
    });
  });
});
