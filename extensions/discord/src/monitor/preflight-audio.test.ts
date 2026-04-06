import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioResultMock = vi.hoisted(() => vi.fn());

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudioResult: transcribeFirstAudioResultMock,
}));

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";

const baseCfg = {} as OpenClawConfig;

function createAudioAttachment(url = "https://cdn.discordapp.com/attachments/voice.ogg") {
  return { content_type: "audio/ogg", url };
}

beforeEach(() => {
  transcribeFirstAudioResultMock.mockReset();
});

describe("resolveDiscordPreflightAudioMentionContext", () => {
  it("transcribes DM voice notes without mention requirement", async () => {
    transcribeFirstAudioResultMock.mockResolvedValueOnce({
      transcript: "hello from a voice note",
      attachmentIndex: 0,
    });

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioResultMock).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBe("hello from a voice note");
    expect(result.transcribedAttachmentIndex).toBe(0);
    expect(result.hasAudioAttachment).toBe(true);
    expect(result.hasTypedText).toBe(false);
  });

  it("passes chat scope metadata into DM preflight transcription", async () => {
    transcribeFirstAudioResultMock.mockResolvedValueOnce({
      transcript: "hello from a voice note",
      attachmentIndex: 0,
    });

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

    expect(transcribeFirstAudioResultMock).toHaveBeenCalledWith(
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

  it("uses the actual transcribed attachment index returned by media preflight", async () => {
    transcribeFirstAudioResultMock.mockResolvedValueOnce({
      transcript: "picked last attachment",
      attachmentIndex: 1,
    });

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          createAudioAttachment("https://cdn.discordapp.com/attachments/voice-1.ogg"),
          createAudioAttachment("https://cdn.discordapp.com/attachments/voice-2.ogg"),
        ],
        content: "",
      },
      chatType: "direct",
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: {
        tools: {
          media: {
            audio: {
              attachments: {
                prefer: "last",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.transcript).toBe("picked last attachment");
    expect(result.transcribedAttachmentIndex).toBe(1);
  });

  it("transcribes guild voice notes when mention is required and regexes are present", async () => {
    transcribeFirstAudioResultMock.mockResolvedValueOnce({
      transcript: "guild voice",
      attachmentIndex: 0,
    });

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: { attachments: [createAudioAttachment()], content: "" },
      chatType: "channel",
      shouldRequireMention: true,
      mentionRegexes: [/bot/i],
      cfg: baseCfg,
    });

    expect(transcribeFirstAudioResultMock).toHaveBeenCalledTimes(1);
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

    expect(transcribeFirstAudioResultMock).not.toHaveBeenCalled();
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

    expect(transcribeFirstAudioResultMock).not.toHaveBeenCalled();
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

    expect(transcribeFirstAudioResultMock).not.toHaveBeenCalled();
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

    expect(transcribeFirstAudioResultMock).not.toHaveBeenCalled();
    expect(result.hasAudioAttachment).toBe(false);
    expect(result.transcript).toBeUndefined();
  });

  it("clears transcript when abortSignal fires during transcription", async () => {
    const controller = new AbortController();
    transcribeFirstAudioResultMock.mockImplementation(async () => {
      controller.abort();
      return { transcript: "should be cleared", attachmentIndex: 0 };
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
    transcribeFirstAudioResultMock.mockRejectedValueOnce(new Error("whisper crashed"));

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
