import { describe, expect, it, vi } from "vitest";
import {
  enrichInboundAudioMessage,
  enrichInboundAudioTranscript,
  isInboundAudioEnricherEnabled,
  selectAudioAttachmentForTranscript,
} from "./inbound-audio-enricher.js";
import { isBlueBubblesAudioAttachment } from "./monitor-normalize.js";
import type { BlueBubblesAccountConfig, BlueBubblesAttachment } from "./types.js";

type ClientStub = {
  getAudioTranscript: ReturnType<typeof vi.fn>;
};

function makeClientStub(transcript: string | null): ClientStub {
  return {
    getAudioTranscript: vi.fn().mockResolvedValue(transcript),
  };
}

function makeAccount(overrides: Partial<BlueBubblesAccountConfig> = {}): BlueBubblesAccountConfig {
  return {
    enabled: true,
    ...overrides,
  };
}

describe("isBlueBubblesAudioAttachment", () => {
  it("detects audio by `audio/*` MIME type", () => {
    expect(isBlueBubblesAudioAttachment({ mimeType: "audio/x-m4a" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ mimeType: "audio/mp4" })).toBe(true);
  });

  it("detects audio by Apple UTI even when MIME is missing", () => {
    expect(isBlueBubblesAudioAttachment({ uti: "public.audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "public.mpeg-4-audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "com.apple.m4a-audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "com.apple.coreaudio-format" })).toBe(true);
  });

  it("treats UTI matching as case-insensitive", () => {
    expect(isBlueBubblesAudioAttachment({ uti: "Public.Audio" })).toBe(true);
  });

  it("returns false for image / video / unknown attachments", () => {
    expect(isBlueBubblesAudioAttachment({ mimeType: "image/jpeg" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({ mimeType: "video/quicktime" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({ uti: "public.jpeg" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({})).toBe(false);
  });
});

describe("isInboundAudioEnricherEnabled", () => {
  it("defaults to enabled when config is absent", () => {
    expect(isInboundAudioEnricherEnabled(makeAccount())).toBe(true);
  });

  it("respects explicit enabled=false", () => {
    expect(
      isInboundAudioEnricherEnabled(makeAccount({ inboundAudioEnricher: { enabled: false } })),
    ).toBe(false);
  });

  it("respects perType.audio=false even when top-level enabled is true", () => {
    expect(
      isInboundAudioEnricherEnabled(
        makeAccount({ inboundAudioEnricher: { enabled: true, perType: { audio: false } } }),
      ),
    ).toBe(false);
  });
});

describe("selectAudioAttachmentForTranscript", () => {
  it("returns the first audio attachment with a guid when ALL attachments are audio", () => {
    const attachments: BlueBubblesAttachment[] = [
      { guid: "voice-1", uti: "public.audio" },
      { guid: "voice-2", mimeType: "audio/x-m4a" },
    ];
    expect(selectAudioAttachmentForTranscript(attachments)?.guid).toBe("voice-1");
  });

  it("prefers the first guid-bearing audio when an earlier audio entry is missing its guid", () => {
    const attachments: BlueBubblesAttachment[] = [
      { uti: "public.audio" },
      { guid: "voice-2", uti: "public.audio" },
    ];
    expect(selectAudioAttachmentForTranscript(attachments)?.guid).toBe("voice-2");
  });

  it("returns undefined for mixed audio + image so the image cue is not masked", () => {
    const mixed: BlueBubblesAttachment[] = [
      { guid: "img-1", mimeType: "image/jpeg" },
      { guid: "voice-1", uti: "public.audio" },
    ];
    expect(selectAudioAttachmentForTranscript(mixed)).toBeUndefined();
  });

  it("returns undefined when no audio attachment is present", () => {
    expect(
      selectAudioAttachmentForTranscript([{ guid: "img-1", mimeType: "image/jpeg" }]),
    ).toBeUndefined();
  });

  it("returns undefined when the only audio attachment lacks a guid", () => {
    expect(selectAudioAttachmentForTranscript([{ uti: "public.audio" }])).toBeUndefined();
  });

  it("returns undefined for empty attachment list", () => {
    expect(selectAudioAttachmentForTranscript([])).toBeUndefined();
  });
});

describe("enrichInboundAudioTranscript", () => {
  const audioAttachment: BlueBubblesAttachment = { guid: "voice-1", uti: "public.audio" };

  it("returns the BB transcript when enabled and audio is present", async () => {
    const client = makeClientStub("Hey, can you grab milk?");
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(result).toBe("Hey, can you grab milk?");
    expect(client.getAudioTranscript).toHaveBeenCalledWith({
      messageGuid: "msg-1",
      timeoutMs: expect.any(Number),
    });
  });

  it("returns null when enricher is disabled and never calls the BB endpoint", async () => {
    const client = makeClientStub("nope");
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount({ inboundAudioEnricher: { enabled: false } }),
    });
    expect(result).toBeNull();
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("does not overwrite a user-typed text body alongside the voice note", async () => {
    const client = makeClientStub("transcript should not run");
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "Listen to this",
      account: makeAccount(),
    });
    expect(result).toBeNull();
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns null when there is no audio attachment", async () => {
    const client = makeClientStub("ignored");
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [{ guid: "img-1", mimeType: "image/jpeg" }],
      existingText: "",
      account: makeAccount(),
    });
    expect(result).toBeNull();
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns null when the BB endpoint has no transcript (older BB)", async () => {
    const client = makeClientStub(null);
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the client rejects", async () => {
    const client: ClientStub = {
      getAudioTranscript: vi.fn().mockRejectedValue(new Error("network")),
    };
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(result).toBeNull();
  });

  it("returns null when the message guid is missing", async () => {
    const client = makeClientStub("ignored");
    const result = await enrichInboundAudioTranscript({
      client: client as never,
      messageGuid: undefined,
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(result).toBeNull();
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });
});

describe("enrichInboundAudioMessage (structured outcome)", () => {
  const audioAttachment: BlueBubblesAttachment = { guid: "voice-1", uti: "public.audio" };

  it("returns reason=applied with the transcript when BB succeeds", async () => {
    const client = makeClientStub("Hi there");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "applied", transcript: "Hi there" });
  });

  it("returns reason=disabled when the enricher flag is off", async () => {
    const client = makeClientStub("ignored");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount({ inboundAudioEnricher: { enabled: false } }),
    });
    expect(outcome).toEqual({ reason: "disabled" });
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns reason=skipped when user typed text alongside audio", async () => {
    const client = makeClientStub("ignored");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "Listen to this",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "skipped" });
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns reason=skipped when the message guid is missing", async () => {
    const client = makeClientStub("ignored");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: undefined,
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "skipped" });
  });

  it("returns reason=no-audio for image-only attachments", async () => {
    const client = makeClientStub("ignored");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [{ guid: "img-1", mimeType: "image/jpeg" }],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "no-audio" });
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns reason=no-audio for mixed audio + image so the image cue is preserved", async () => {
    const client = makeClientStub("ignored");
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment, { guid: "img-1", mimeType: "image/jpeg" }],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "no-audio" });
    expect(client.getAudioTranscript).not.toHaveBeenCalled();
  });

  it("returns reason=no-transcript when BB returns null (older BB Server)", async () => {
    const client = makeClientStub(null);
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "no-transcript" });
  });

  it("returns reason=no-transcript instead of throwing on transport error", async () => {
    const client = { getAudioTranscript: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const outcome = await enrichInboundAudioMessage({
      client: client as never,
      messageGuid: "msg-1",
      attachments: [audioAttachment],
      existingText: "",
      account: makeAccount(),
    });
    expect(outcome).toEqual({ reason: "no-transcript" });
  });
});
