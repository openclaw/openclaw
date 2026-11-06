import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import {
  discardSlackPreflightMedia,
  findSlackPreflightAudioFile,
  formatSlackAudioTranscriptForAgent,
  resolveSlackPreflightAudioTranscript,
} from "./preflight-audio.js";

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

describe("Slack captionless audio preflight", () => {
  it("recognizes captionless Slack audio independently of Slack's video MIME", () => {
    const voiceClip: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      files: [{ name: "voice.mp4", mimetype: "video/mp4", subtype: "slack_audio" }],
    };
    expect(findSlackPreflightAudioFile(voiceClip)).toEqual(voiceClip.files?.[0]);
    expect(findSlackPreflightAudioFile({ ...voiceClip, text: "typed caption" })).toBeUndefined();
    expect(
      findSlackPreflightAudioFile({
        ...voiceClip,
        files: [{ name: "screen.mp4", mimetype: "video/mp4" }],
      }),
    ).toBeUndefined();
  });

  it("frames machine transcripts as untrusted input without replacing the file placeholder", () => {
    expect(
      formatSlackAudioTranscriptForAgent({
        transcript: 'Bill said "review it"',
        rawBody: "[Slack file: voice.mp4 (fileId: F1)]",
      }),
    ).toBe(
      '[Audio transcript (machine-generated, untrusted)]: "Bill said \\"review it\\""\n' +
        "[Slack file: voice.mp4 (fileId: F1)]",
    );
  });

  it("transcribes the first audio attachment and returns its ordered media index", async () => {
    transcribeFirstAudioMock.mockResolvedValue("Bill please review this");
    const cfg = {};
    const media = [
      { path: "/tmp/image.png", contentType: "image/png", placeholder: "[image]" },
      { path: "/tmp/voice.mp4", contentType: "audio/mp4", placeholder: "[voice]" },
    ];

    const result = await resolveSlackPreflightAudioTranscript({
      media,
      cfg,
      accountId: "work",
      originatingTo: "channel:C1",
      sessionKey: "agent:main:slack:channel:c1",
      messageThreadId: "1.000",
    });
    expect(result).toEqual({ transcript: "Bill please review this", mediaIndex: 1 });
    expect(transcribeFirstAudioMock).toHaveBeenCalledExactlyOnceWith({
      ctx: expect.objectContaining({
        media,
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C1",
        AccountId: "work",
        MessageThreadId: "1.000",
        SessionKey: "agent:main:slack:channel:c1",
      }),
      cfg,
    });
  });

  it("removes preflight downloads when the transcript does not admit the message", () =>
    withTempDir("openclaw-slack-audio-preflight-", async (root) => {
      const audioPath = path.join(root, "voice.mp4");
      await fs.writeFile(audioPath, "voice");
      await discardSlackPreflightMedia([
        { path: audioPath, contentType: "audio/mp4", placeholder: "[voice]" },
      ]);
      await expect(fs.stat(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    }));
});
