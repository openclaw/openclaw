import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock, sendTranscriptEchoMock, transcribeFirstAudioMock } = vi.hoisted(
  () => ({
    downloadMatrixMediaMock: vi.fn(),
    sendTranscriptEchoMock: vi.fn(),
    transcribeFirstAudioMock: vi.fn(),
  }),
);

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
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
        sendTranscriptEcho: sendTranscriptEchoMock,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});

type HarnessOptions = NonNullable<Parameters<typeof createMatrixHandlerTestHarness>[0]>;
type MessageContent = Parameters<typeof createMatrixRoomMessageEvent>[0]["content"];
const media = {
  path: "/tmp/inbound/voice.ogg",
  contentType: "audio/ogg",
  placeholder: "[matrix audio attachment]",
};

function setup(room = false, overrides: HarnessOptions = {}) {
  const harness = createMatrixHandlerTestHarness({
    isDirectMessage: !room,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    ...(room
      ? {
          historyLimit: 5,
          mentionRegexes: [/\bbot\b/i],
          roomsConfig: { "!room:example.org": { requireMention: true } },
        }
      : {}),
    ...overrides,
  });
  const receive = (eventId: string, content: MessageContent) =>
    harness.handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({ eventId, sender: "@frank:matrix.example.org", content }),
    );
  return {
    ...harness,
    context: () => harness.runPrepared.mock.calls.at(-1)![0].ctxPayload,
    voice: (content: MessageContent = {}) =>
      receive("$audio1", {
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example/voice",
        info: { mimetype: "audio/ogg", size: 12345 },
        ...content,
      }),
    text: (eventId: string, body: string) => receive(eventId, { msgtype: "m.text", body }),
  };
}

describe("createMatrixRoomMessageHandler audio preflight", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset().mockResolvedValue(media);
    sendTranscriptEchoMock.mockReset();
    transcribeFirstAudioMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("transcribes encrypted room audio when a blank top-level URL masks its file URL", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      ...media,
      path: "/tmp/inbound/encrypted-voice.ogg",
    });
    transcribeFirstAudioMock.mockResolvedValue("bot can you hear this encrypted voice note");
    const f = setup(true);
    const file = {
      url: "mxc://example/encrypted-voice",
      key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };
    await f.voice({ body: " \t ", url: " ", file });
    expect(downloadMatrixMediaMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mxcUrl: "mxc://example/encrypted-voice", file }),
    );
    expect(transcribeFirstAudioMock).toHaveBeenCalledOnce();
    expect(f.recordInboundSession).toHaveBeenCalled();
    expect(f.context()).toMatchObject({
      BodyForAgent: expect.stringContaining("bot can you hear this encrypted voice note"),
      MediaPath: "/tmp/inbound/encrypted-voice.ogg",
      WasMentioned: true,
    });
  });

  it("keeps non-filename audio fallback text while still surfacing the transcript", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello bot from fallback audio");
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
    transcribeFirstAudioMock.mockResolvedValue("hello world");
    const f = setup(true);
    await f.voice();
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
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
    expect(downloadMatrixMediaMock).not.toHaveBeenCalled();
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(f.recordInboundSession).not.toHaveBeenCalled();
  });

  it("does not hold the room history ingress queue during slow audio preflight", async () => {
    const downloading = createDeferred<void>();
    const download = createDeferred<typeof media>();
    downloadMatrixMediaMock.mockImplementation(() => {
      downloading.resolve();
      return download.promise;
    });
    transcribeFirstAudioMock.mockResolvedValue("bot voice request");
    const f = setup(true);
    const slowAudio = f.voice();
    await downloading.promise;
    await f.text("$text-after-audio", "bot text after audio");
    expect(f.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ BodyForAgent: "bot text after audio" }),
      }),
    );
    download.resolve(media);
    await slowAudio;
    const voice = f.runPrepared.mock.calls.find(([turn]) =>
      turn.ctxPayload.BodyForAgent?.includes("bot voice request"),
    )![0].ctxPayload;
    expect(voice.InboundHistory?.map((entry) => entry.body) ?? []).not.toContain(
      "bot text after audio",
    );
  });
});
