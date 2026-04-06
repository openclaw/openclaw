import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";

const baseCfg = {} as OpenClawConfig;

function createAudioAttachment(url = "https://cdn.discordapp.com/attachments/voice.ogg") {
  return { content_type: "audio/ogg", url };
}

beforeEach(() => {
  transcribeFirstAudioMock.mockReset();
});

describe("resolveDiscordPreflightAudioMentionContext", () => {
  it("transcribes DM voice notes without mention requirement", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a voice note");

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBe("hello from a voice note");
    expect(result.transcribedAttachmentIndex).toBe(0);
    expect(result.hasAudioAttachment).toBe(true);
    expect(result.hasTypedText).toBe(false);
  });

  it("passes chat scope metadata into DM preflight transcription", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hello from a voice note");

    await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "direct",
      sessionKey: "agent:main:discord:user:42",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: {
        tools: {
          media: {
            audio: {
              scope: {
                default: "deny",
                rules: [{ action: "allow", match: { channel: "discord", chatType: "direct" } }],
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          ChatType: "direct",
          SessionKey: "agent:main:discord:user:42",
          Surface: "discord",
          Provider: "discord",
        }),
      }),
    );
  });

  it("transcribes guild voice notes when mention is required and regexes are present", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("guild voice");

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "channel",
      shouldRequireMention: true,
      mentionRegexes: [/bot/i],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBe("guild voice");
  });

  it("skips transcription in guild when mention is not required", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "channel",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result.transcript).toBeUndefined();
    expect(result.hasAudioAttachment).toBe(true);
  });

  it("skips transcription in guild when mention regexes are empty", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "channel",
      shouldRequireMention: true,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result.transcript).toBeUndefined();
  });

  it("skips transcription when user typed text alongside audio", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "I also typed something" },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result.hasTypedText).toBe(true);
    expect(result.transcript).toBeUndefined();
  });

  it("skips transcription when there are no audio attachments", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [{ content_type: "image/png", url: "https://example.com/img.png" }],
        content: "",
      },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result.hasAudioAttachment).toBe(false);
    expect(result.transcript).toBeUndefined();
  });

  it("clears transcript when abortSignal fires during transcription", async () => {
    const controller = new AbortController();
    transcribeFirstAudioMock.mockImplementation(async () => {
      controller.abort();
      return "should be cleared";
    });

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
      abortSignal: controller.signal,
    });

    expect(result.transcript).toBeUndefined();
    expect(result.transcribedAttachmentIndex).toBeUndefined();
  });

  it("handles transcription errors gracefully", async () => {
    transcribeFirstAudioMock.mockRejectedValueOnce(new Error("whisper crashed"));

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(result.transcript).toBeUndefined();
    expect(result.hasAudioAttachment).toBe(true);
  });
});
