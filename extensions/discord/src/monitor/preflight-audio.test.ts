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

  it("preflights DM audio by filename without requiring a mention", async () => {
    const url = "https://cdn.discordapp.com/attachments/voice.opus";
    transcribeFirstAudioMock.mockResolvedValue("hello from dm");
    const result = await preflight({ attachments: [{ url, filename: "voice.opus" }] });
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: { media: [{ url, contentType: "audio/opus" }] },
      cfg,
      agentDir: undefined,
    });
    expect(result).toEqual({ hasTypedText: false, transcript: "hello from dm" });
  });

  it.each([
    {
      name: "typed direct-message audio",
      content: "typed caption",
      hasTypedText: true,
      attachment: {
        url: "https://cdn.discordapp.com/attachments/voice.ogg",
        content_type: "audio/ogg",
        filename: "voice.ogg",
      },
    },
    {
      name: "a duration-bearing image",
      content: undefined,
      hasTypedText: false,
      attachment: {
        url: "https://cdn.discordapp.com/attachments/photo.png",
        content_type: "image/png",
        filename: "photo.png",
        duration_secs: 0.5,
      },
    },
  ])("does not preflight $name", async ({ content, attachment, hasTypedText }) => {
    const result = await preflight({ content, attachments: [attachment] });
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toEqual({ hasTypedText });
  });

  it("still preflights a waveform-bearing voice note with a definitive video MIME", async () => {
    transcribeFirstAudioMock.mockResolvedValue("waveform over video mime transcript");

    const url = "https://cdn.discordapp.com/attachments/voice";
    await preflight({
      attachments: [
        {
          url,
          content_type: "video/ogg",
          filename: "voice",
          duration_secs: 1.5,
          waveform: "AAAA",
        },
      ],
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith({
      ctx: { media: [{ url, contentType: "audio/ogg" }] },
      cfg,
      agentDir: undefined,
    });
  });
});
