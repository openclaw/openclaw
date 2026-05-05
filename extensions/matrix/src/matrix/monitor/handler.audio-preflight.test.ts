import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock, transcribeFirstAudioMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));

function createAudioPreflightHarness(
  overrides: Parameters<typeof createMatrixHandlerTestHarness>[0] = {},
) {
  return createMatrixHandlerTestHarness({
    isDirectMessage: true,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    resolveAgentRoute: () => ({
      agentId: "main",
      accountId: "ops",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      mainSessionKey: "agent:main:main",
      channel: "matrix",
      matchedBy: "binding.account",
    }),
    resolveStorePath: () => "/tmp/openclaw-test-session.json",
    readSessionUpdatedAt: () => 123,
    getRoomInfo: async () => ({
      name: "Audio Room",
      canonicalAlias: "#audio:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: async () => "Frank",
    startupMs: Date.now() - 120_000,
    startupGraceMs: 60_000,
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
    ...overrides,
  });
}

function createAudioEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    eventId: "$audio1",
    sender: "@frank:matrix.example.org",
    content: content as never,
  });
}

describe("createMatrixRoomMessageHandler audio preflight", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    transcribeFirstAudioMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("transcribes inbound voice notes in DMs and surfaces the transcript as the agent body", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello bot");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPaths: ["/tmp/inbound/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        }),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "hello bot"',
          MediaTranscribedIndexes: [0],
          MediaPath: "/tmp/inbound/voice.ogg",
          MediaType: "audio/ogg",
        }),
      }),
    );
  });

  it("treats m.file with an audio mimetype as a voice note for preflight", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.opus",
      contentType: "audio/opus",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("opus transcript");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.file",
        body: "voice.opus",
        filename: "voice.opus",
        url: "mxc://example/voice",
        info: { mimetype: "audio/opus", size: 23456 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaTranscribedIndexes: [0],
        }),
      }),
    );
  });

  it("lets a transcript-mentioned bot bypass the requireMention gate in a room", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("bot can you check this");
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      isDirectMessage: false,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: expect.stringContaining("bot can you check this"),
          WasMentioned: true,
        }),
      }),
    );
  });

  it("drops voice notes in requireMention rooms when the transcript does not match the bot", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello world how are you");
    const { handler, recordInboundSession } = createAudioPreflightHarness({
      isDirectMessage: false,
      mentionRegexes: [/\bbot\b/i],
      roomsConfig: {
        "!room:example.org": { requireMention: true } as never,
      },
    });

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("falls through to the placeholder body when transcription fails", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockRejectedValue(new Error("STT down"));
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: "[matrix audio attachment]",
          MediaTranscribedIndexes: undefined,
          MediaPath: "/tmp/inbound/voice.ogg",
        }),
      }),
    );
  });

  it("does not invoke audio preflight for non-audio media", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/photo.jpg",
      contentType: "image/jpeg",
      placeholder: "[matrix media]",
    });
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.image",
        body: "photo.jpg",
        url: "mxc://example/photo",
        info: { mimetype: "image/jpeg", size: 12345 },
      }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("transcribes encrypted voice notes after decryption via the existing crypto adapter", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/encrypted-voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("encrypted hello");
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        file: {
          url: "mxc://example/encrypted-voice",
          key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mxcUrl: "mxc://example/encrypted-voice",
        file: expect.objectContaining({
          url: "mxc://example/encrypted-voice",
          key: expect.objectContaining({ alg: "A256CTR" }),
        }),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "encrypted hello"',
          MediaTranscribedIndexes: [0],
          MediaPath: "/tmp/inbound/encrypted-voice.ogg",
        }),
      }),
    );
  });

  it("preserves the too-large placeholder when the audio download exceeds the size limit", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "big-voice.ogg",
        url: "mxc://example/big-voice",
        info: { mimetype: "audio/ogg", size: 10 * 1024 * 1024 },
      }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: "[matrix audio attachment too large]",
          MediaTranscribedIndexes: undefined,
          MediaPath: undefined,
        }),
      }),
    );
  });

  it("downloads the audio attachment exactly once across preflight and the existing media path", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/voice.ogg",
      contentType: "audio/ogg",
      placeholder: "[matrix audio attachment]",
    });
    transcribeFirstAudioMock.mockResolvedValue("hello bot");
    const { handler } = createAudioPreflightHarness();

    await handler(
      "!room:example.org",
      createAudioEvent({
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledTimes(1);
  });
});
