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

function preflight(
  message: Parameters<typeof resolveDiscordPreflightAudioMentionContext>[0]["message"],
) {
  return resolveDiscordPreflightAudioMentionContext({
    message,
    isDirectMessage: true,
    shouldRequireMention: false,
    mentionRegexes: [],
    cfg,
  });
}

describe("resolveDiscordPreflightAudioMentionContext", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it.each([
    {
      name: "declared content type",
      attachment: {
        url: "https://cdn.discordapp.com/attachments/voice.ogg",
        content_type: "audio/ogg",
        filename: "voice.ogg",
      },
      expected: {
        url: "https://cdn.discordapp.com/attachments/voice.ogg",
        contentType: "audio/ogg",
      },
    },
    {
      name: "filename without content type",
      attachment: {
        url: "https://cdn.discordapp.com/attachments/voice.opus",
        filename: "voice.opus",
      },
      expected: {
        url: "https://cdn.discordapp.com/attachments/voice.opus",
        contentType: "audio/opus",
      },
    },
    {
      name: "voice waveform metadata",
      attachment: {
        url: " https://cdn.discordapp.com/attachments/voice ",
        filename: "voice",
        duration_secs: 1.5,
        waveform: "AAAA",
      },
      expected: { url: "https://cdn.discordapp.com/attachments/voice", contentType: "audio/ogg" },
    },
  ])(
    "preflights direct-message audio from $name without requiring a mention",
    async ({ attachment, expected }) => {
      transcribeFirstAudioMock.mockResolvedValue("hello from dm");
      const result = await preflight({ attachments: [attachment] });

      expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
        ctx: { media: [expected] },
        cfg,
        agentDir: undefined,
      });
      expect(result).toEqual({
        hasAudioAttachment: true,
        hasTypedText: false,
        transcript: "hello from dm",
      });
    },
  );

  it("does not preflight typed direct-message audio", async () => {
    const result = await preflight({
      content: "typed caption",
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
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
    const result = await preflight({
      attachments: [
        {
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasAudioAttachment: false,
      hasTypedText: false,
    });
  });
});
