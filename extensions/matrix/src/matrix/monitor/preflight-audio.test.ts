import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

import {
  formatMatrixAudioTranscript,
  isMatrixAudioContent,
  resolveMatrixPreflightAudioTranscript,
} from "./preflight-audio.js";

const cfg = {} as import("openclaw/plugin-sdk/config-runtime").OpenClawConfig;

describe("isMatrixAudioContent", () => {
  it("returns true for m.audio msgtype regardless of mimetype", () => {
    expect(isMatrixAudioContent({ msgtype: "m.audio" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.audio", mimetype: "audio/opus" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.audio", mimetype: undefined })).toBe(true);
  });

  it("returns true for m.file with an audio mimetype", () => {
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "audio/ogg" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "audio/mpeg" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "AUDIO/MP4" })).toBe(true);
  });

  it("returns false for m.file without an audio mimetype", () => {
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "image/png" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "application/pdf" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.file" })).toBe(false);
  });

  it("returns false for non-audio msgtypes", () => {
    expect(isMatrixAudioContent({ msgtype: "m.image" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.video", mimetype: "video/mp4" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.text" })).toBe(false);
  });

  it("returns false when msgtype is missing", () => {
    expect(isMatrixAudioContent({})).toBe(false);
    expect(isMatrixAudioContent({ mimetype: "audio/ogg" })).toBe(false);
  });
});

describe("formatMatrixAudioTranscript", () => {
  it("wraps the transcript with prompt-injection framing and JSON-encodes the payload", () => {
    expect(formatMatrixAudioTranscript("hello world")).toBe(
      `[Audio transcript (machine-generated, untrusted)]: "hello world"`,
    );
  });

  it("escapes control characters and embedded quotes", () => {
    expect(formatMatrixAudioTranscript('say "hi"\n then go')).toBe(
      `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify('say "hi"\n then go')}`,
    );
  });
});

describe("resolveMatrixPreflightAudioTranscript", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("forwards the local media path and content type to transcribeFirstAudio", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from voice");

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPaths: ["/tmp/inbound/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
        cfg,
      }),
    );
    expect(transcript).toBe("hello from voice");
  });

  it("omits MediaTypes when no content type is provided", async () => {
    transcribeFirstAudioMock.mockResolvedValue("transcript");

    await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      cfg,
    });

    const args = transcribeFirstAudioMock.mock.calls[0]?.[0] as {
      ctx: { MediaPaths?: string[]; MediaTypes?: string[] };
    };
    expect(args.ctx.MediaPaths).toEqual(["/tmp/inbound/voice.ogg"]);
    expect(args.ctx.MediaTypes).toBeUndefined();
  });

  it("returns undefined when the runtime throws", async () => {
    transcribeFirstAudioMock.mockRejectedValue(new Error("STT provider unavailable"));

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
    });

    expect(transcript).toBeUndefined();
  });

  it("returns undefined when the runtime returns undefined", async () => {
    transcribeFirstAudioMock.mockResolvedValue(undefined);

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
    });

    expect(transcript).toBeUndefined();
  });

  it("returns undefined without invoking the runtime when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
      abortSignal: controller.signal,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(transcript).toBeUndefined();
  });

  it("returns undefined when the abort signal fires after the runtime call resolves", async () => {
    const controller = new AbortController();
    transcribeFirstAudioMock.mockImplementation(async () => {
      controller.abort();
      return "would-be-transcript";
    });

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
      abortSignal: controller.signal,
    });

    expect(transcript).toBeUndefined();
  });
});
