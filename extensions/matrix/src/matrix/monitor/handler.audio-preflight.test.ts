import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixRoomMessageEvent as roomMessage,
} from "./handler.test-helpers.js";

const { download, echo, transcribe } = vi.hoisted(() => ({
  download: vi.fn(),
  echo: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: download,
  };
});

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
        sendTranscriptEcho: echo,
        transcribeFirstAudio: transcribe,
      }),
  };
});

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;
type MessageContent = Parameters<typeof roomMessage>[0]["content"];
const media = {
  path: "/tmp/inbound/voice.ogg",
  contentType: "audio/ogg",
  placeholder: "[matrix audio attachment]",
};

function setup(room = false, overrides: HarnessOptions = {}) {
  const harness = createHarness({
    isDirectMessage: !room,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    historyLimit: room ? 5 : 0,
    mentionRegexes: room ? [/\bbot\b/i] : [],
    roomsConfig: room ? { "!room:example.org": { requireMention: true } } : undefined,
    ...overrides,
  });
  const receive = (
    eventId: string,
    content: MessageContent,
    sender = "@frank:matrix.example.org",
  ) => harness.handler("!room:example.org", roomMessage({ eventId, sender, content }));
  return {
    ...harness,
    receive,
    context: () => harness.runPrepared.mock.calls.at(-1)![0].ctxPayload,
    voice: (content: MessageContent = {}) =>
      receive("$audio1", {
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg" },
        ...content,
      }),
    text: (eventId: string, body: string) => receive(eventId, { msgtype: "m.text", body }),
  };
}

function createMediaFailureHarness() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = { error: vi.fn() };
  const harness = setup(false, {
    logger: logger as never,
    runtime: runtime as never,
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
  });

  return {
    logger,
    runtime,
    image: async (content: Parameters<typeof roomMessage>[0]["content"]) => {
      await harness.receive(
        "$event1",
        {
          msgtype: "m.image",
          url: "mxc://example/image",
          ...content,
          "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
        },
        "@gum:matrix.example.org",
      );
      const ctx = harness.context();
      expect(harness.recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({ ctx }));
      return ctx;
    },
  };
}

describe("createMatrixRoomMessageHandler inbound media", () => {
  beforeEach(() => {
    download.mockReset().mockResolvedValue(media);
    echo.mockReset();
    transcribe.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it.each([false, true])(
    "passes local audio and %s room context to transcription",
    async (room) => {
      const cfg = { channels: { matrix: { dm: { allowFrom: ["*"] } } } };
      transcribe.mockResolvedValue("bot hello from voice");
      const f = setup(room, { cfg, accountId: "ops" });
      await f.voice(room ? { "m.relates_to": { rel_type: "m.thread", event_id: "$thread" } } : {});
      expect(transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            media: [{ path: media.path, contentType: "audio/ogg" }],
            Provider: "matrix",
            Surface: "matrix",
            OriginatingChannel: "matrix",
            OriginatingTo: "room:!room:example.org",
            AccountId: "ops",
            MessageThreadId: room ? "$thread" : undefined,
            ChatType: room ? "channel" : "direct",
            SessionKey: room ? "agent:ops:main:thread:$thread" : "agent:ops:main",
          }),
          cfg,
        }),
      );
      expect(f.context()).toMatchObject({
        BodyForAgent: expect.stringContaining("bot hello from voice"),
        MediaTranscribedIndexes: [0],
      });
    },
  );

  it("downloads encrypted image attachments when the top-level URL is blank", async () => {
    download.mockResolvedValue({
      path: "/tmp/inbound/encrypted-image.png",
      contentType: "image/png",
      placeholder: "[matrix image attachment]",
    });
    const { image } = createMediaFailureHarness();
    const file = {
      url: "mxc://example/encrypted-image",
      key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };

    const ctx = await image({
      body: " \t ",
      filename: " encrypted-image.png ",
      url: " \t ",
      file,
      info: { mimetype: "image/png", size: 123 },
    });

    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        mxcUrl: "mxc://example/encrypted-image",
        file,
        originalFilename: "encrypted-image.png",
      }),
    );
    expect(ctx.MediaPath).toBe("/tmp/inbound/encrypted-image.png");
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    download.mockRejectedValue(new Error("download failed"));
    const { image, logger, runtime } = createMediaFailureHarness();
    const ctx = await image({ body: "image.png" });

    expect(ctx).toMatchObject({
      RawBody: "[matrix image attachment unavailable]",
      CommandBody: "[matrix image attachment unavailable]",
    });
    expect(ctx.MediaPath).toBeUndefined();
    expect(logger.warn.mock.calls[0]).toEqual([
      "matrix media download failed",
      expect.objectContaining({ eventId: "$event1", msgtype: "m.image", encrypted: false }),
    ]);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("preserves a real caption while marking the attachment too large on size limit error", async () => {
    download.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { image } = createMediaFailureHarness();
    const ctx = await image({
      body: "check this out",
      filename: "large-photo.jpg",
      url: "mxc://example/big-image",
    });

    expect(ctx).toMatchObject({
      RawBody: "check this out\n\n[matrix image attachment too large]",
      CommandBody: "check this out\n\n[matrix image attachment too large]",
    });
  });

  it("transcribes encrypted room audio when a blank top-level URL masks its file URL", async () => {
    download.mockResolvedValue({ ...media, path: "/tmp/inbound/encrypted-voice.ogg" });
    transcribe.mockResolvedValue("bot can you hear this encrypted voice note");
    const f = setup(true);
    const file = {
      url: "mxc://example/encrypted-voice",
      key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };
    await f.voice({ body: " \t ", url: " ", file });
    expect(download).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mxcUrl: "mxc://example/encrypted-voice", file }),
    );
    expect(transcribe).toHaveBeenCalledOnce();
    expect(f.recordInboundSession).toHaveBeenCalled();
    expect(f.context()).toMatchObject({
      BodyForAgent: expect.stringContaining("bot can you hear this encrypted voice note"),
      MediaPath: "/tmp/inbound/encrypted-voice.ogg",
      WasMentioned: true,
    });
  });

  it("keeps non-filename audio fallback text while still surfacing the transcript", async () => {
    transcribe.mockResolvedValue("hello bot from fallback audio");
    const f = setup();
    await f.voice({ body: "Voice message" });
    expect(f.recordInboundSession).toHaveBeenCalled();
    expect(f.context()).toMatchObject({
      BodyForAgent:
        'Voice message\n[Audio transcript (machine-generated, untrusted)]: "hello bot from fallback audio"',
      MediaTranscribedIndexes: [0],
    });
  });

  it("drops transcript-unmentioned voice notes in requireMention rooms", async () => {
    transcribe.mockResolvedValue("hello world");
    const f = setup(true);
    await f.voice();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(f.recordInboundSession).not.toHaveBeenCalled();
    await f.text("$text-after-unmentioned-audio", "bot what did I say before?");
    expect(f.recordInboundSession).toHaveBeenCalled();
    expect(f.context().InboundHistory?.map((entry) => entry.body)).toContain(
      '[Audio transcript (machine-generated, untrusted)]: "hello world"',
    );
  });

  it("does not preflight-download gated audio when audio transcription is disabled", async () => {
    const f = setup(true, {
      historyLimit: 0,
      cfg: {
        channels: { matrix: { dm: { allowFrom: ["*"] } } },
        tools: { media: { audio: { enabled: false } } },
      },
    });
    await f.voice();
    expect(download).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(f.recordInboundSession).not.toHaveBeenCalled();
  });

  it("does not hold the room history ingress queue during slow audio preflight", async () => {
    const downloading = createDeferred<void>();
    const pendingDownload = createDeferred<typeof media>();
    download.mockImplementation(() => {
      downloading.resolve();
      return pendingDownload.promise;
    });
    transcribe.mockResolvedValue("bot voice request");
    const f = setup(true);
    const slowAudio = f.voice();
    await downloading.promise;
    await f.text("$text-after-audio", "bot text after audio");
    expect(f.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ BodyForAgent: "bot text after audio" }),
      }),
    );
    pendingDownload.resolve(media);
    await slowAudio;
    const voice = f.runPrepared.mock.calls.find(([turn]) =>
      turn.ctxPayload.BodyForAgent?.includes("bot voice request"),
    )![0].ctxPayload;
    expect(voice.InboundHistory?.map((entry) => entry.body) ?? []).not.toContain(
      "bot text after audio",
    );
  });
});
