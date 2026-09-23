// Discord tests cover preflight audio plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});

import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";

const cfg = {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;

describe("resolveDiscordPreflightAudioMentionContext", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("preflights direct-message audio without requiring a mention", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from dm");

    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: {
        media: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            contentType: "audio/ogg",
          },
        ],
      },
      cfg,
      agentDir: undefined,
    });
    expect(result).toEqual({
      hasAudioAttachment: true,
      hasTypedText: false,
      transcript: "hello from dm",
    });
  });

  it("preflights audio by filename when Discord omits content type", async () => {
    transcribeFirstAudioMock.mockResolvedValue("filename transcript");

    await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.opus",
            filename: "voice.opus",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: {
        media: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.opus",
            contentType: "audio/opus",
          },
        ],
      },
      cfg,
      agentDir: undefined,
    });
  });

  it("preflights Discord voice attachments by waveform metadata", async () => {
    transcribeFirstAudioMock.mockResolvedValue("metadata transcript");

    await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: " https://cdn.discordapp.com/attachments/voice ",
            filename: "voice",
            duration_secs: 1.5,
            waveform: "AAAA",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: {
        media: [
          {
            url: "https://cdn.discordapp.com/attachments/voice",
            contentType: "audio/ogg",
          },
        ],
      },
      cfg,
      agentDir: undefined,
    });
  });

  it("does not preflight typed direct-message audio", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        content: "typed caption",
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: true,
      hasTypedText: true,
    });
  });

  it("does not preflight a duration-bearing video attachment as audio", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/PXL_2024.mp4",
            content_type: "video/mp4",
            filename: "PXL_2024.mp4",
            duration_secs: 11.26,
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: false,
      hasTypedText: false,
    });
  });

  it("does not preflight a duration-bearing image attachment as audio", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/photo.png",
            content_type: "image/png",
            filename: "photo.png",
            duration_secs: 0.5,
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: false,
      hasTypedText: false,
    });
  });

  it("still preflights a waveform-bearing voice note with a definitive video MIME", async () => {
    transcribeFirstAudioMock.mockResolvedValue("waveform over video mime transcript");

    await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/voice",
            content_type: "video/ogg",
            filename: "voice",
            duration_secs: 1.5,
            waveform: "AAAA",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: {
        media: [
          {
            url: "https://cdn.discordapp.com/attachments/voice",
            contentType: "audio/ogg",
          },
        ],
      },
      cfg,
      agentDir: undefined,
    });
  });

  it("ignores URL-less audio attachments", async () => {
    const result = await resolveDiscordPreflightAudioMentionContext({
      message: {
        attachments: [
          {
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      isDirectMessage: true,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: false,
      hasTypedText: false,
    });
  });
});
