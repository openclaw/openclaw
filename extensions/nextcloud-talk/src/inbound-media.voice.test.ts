import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => ({
  createChannelPairingControllerMock: vi.fn(),
  resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
  resolveDefaultGroupPolicyMock: vi.fn(),
  warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
}));

const resolveNextcloudTalkAuthenticatedMediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./inbound-media.js", async () => {
  const actual = await vi.importActual<typeof import("./inbound-media.js")>("./inbound-media.js");
  return {
    ...actual,
    resolveNextcloudTalkAuthenticatedMediaSource: resolveNextcloudTalkAuthenticatedMediaSourceMock,
  };
});

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return { ...actual, resolveNextcloudTalkRoomKind: vi.fn(async () => "direct") };
});

function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.byteLength + payload.byteLength, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function handlerBox(handlerType: "soun" | "vide"): Buffer {
  const payload = Buffer.alloc(24);
  payload.write(handlerType, 8, 4, "ascii");
  return box("hdlr", payload);
}

function sampleDescriptionBox(sampleEntryType: "mp4a" | "avc1"): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1, 4);
  return box("stsd", header, box(sampleEntryType));
}

function trackBox(handlerType: "soun" | "vide"): Buffer {
  const sampleEntryType = handlerType === "soun" ? "mp4a" : "avc1";
  return box(
    "trak",
    box(
      "mdia",
      handlerBox(handlerType),
      box("minf", box("stbl", sampleDescriptionBox(sampleEntryType))),
    ),
  );
}

function isoBmffFixture(...handlerTypes: Array<"soun" | "vide">): Buffer {
  const ftyp = Buffer.alloc(16);
  ftyp.write("M4A ", 0, 4, "ascii");
  ftyp.writeUInt32BE(0x200, 4);
  ftyp.write("isom", 8, 4, "ascii");
  ftyp.write("M4A ", 12, 4, "ascii");
  return Buffer.concat([
    box("ftyp", ftyp),
    box("moov", ...handlerTypes.map(trackBox)),
    box("mdat"),
  ]);
}

function installRuntime(saved: { id: string; path: string; size: number; contentType: string }) {
  const coreRuntime = createPluginRuntimeMock();
  coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => saved);
  setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
  return coreRuntime;
}

function createAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      mediaAllowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
  };
}

function createMessage(fileName: string, mimeType: string, text = ""): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-voice",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "user-1",
    senderName: "Alice",
    text,
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: false,
    attachment: {
      fileId: "media-1",
      name: fileName,
      mimeType,
      declaredSizeBytes: 4_096,
      shareUrl: "https://cloud.example.com/s/redacted-share-token",
      hideDownload: false,
    },
  };
}

function mockAuthenticatedSource(
  fileName: string,
  sourceModality?: "voice",
  contentTypeOverride?: string,
) {
  resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce({
    ok: true,
    url: `https://cloud.example.com/remote.php/dav/files/test-user/Talk/${fileName}`,
    origin: "https://cloud.example.com",
    hostname: "cloud.example.com",
    fileName,
    authorization: "Basic redacted-test-credential",
    ...(sourceModality ? { sourceModality } : {}),
    ...(contentTypeOverride ? { contentTypeOverride } : {}),
  });
}

function runtimeEnv(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
}

function requireBuildContextCall(coreRuntime: ReturnType<typeof createPluginRuntimeMock>) {
  const call = (coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!call) {
    throw new Error("expected Nextcloud Talk inbound context");
  }
  return call[0];
}

const config = { channels: { "nextcloud-talk": {} } } as CoreConfig;
const tempDirs: string[] = [];

async function writeFixture(fileName: string, contents: Buffer): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextcloud-talk-voice-"));
  tempDirs.push(directory);
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe("nextcloud-talk native voice media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map(async (directory) => await fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([
    { label: "Android", detectedType: "video/mp4" },
    { label: "iPad", detectedType: "audio/x-m4a" },
  ])(
    "canonicalizes authenticated $label audio-only MP4 voice media for downstream speech",
    async ({ detectedType }) => {
      const fixture = isoBmffFixture("soun");
      const stagedPath = await writeFixture("native-voice.mp3", fixture);
      const coreRuntime = installRuntime({
        id: "native-voice.mp3",
        path: stagedPath,
        size: fixture.byteLength,
        contentType: detectedType,
      });
      mockAuthenticatedSource("native-voice.mp3", "voice");

      await handleNextcloudTalkInbound({
        message: createMessage("native-voice.mp3", "audio/mpeg"),
        account: createAccount(),
        config,
        runtime: runtimeEnv(),
      });

      const context = requireBuildContextCall(coreRuntime);
      expect(context.message).toMatchObject({
        rawBody: "",
        commandBody: "",
        sourceModality: "voice",
      });
      expect(context.media).toEqual([
        { path: expect.stringMatching(/\.m4a$/u), contentType: "audio/mp4" },
      ]);
      await expect(fs.readFile(context.media[0].path)).resolves.toEqual(fixture);
    },
  );

  it("preserves canonical desktop WAV native voice media and modality", async () => {
    const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "binary");
    const stagedPath = await writeFixture("native-voice.wav", wav);
    const coreRuntime = installRuntime({
      id: "native-voice.wav",
      path: stagedPath,
      size: wav.byteLength,
      contentType: "audio/wav",
    });
    mockAuthenticatedSource("native-voice.wav", "voice");

    await handleNextcloudTalkInbound({
      message: createMessage("native-voice.wav", "audio/wav"),
      account: createAccount(),
      config,
      runtime: runtimeEnv(),
    });

    expect(requireBuildContextCall(coreRuntime)).toMatchObject({
      message: { sourceModality: "voice" },
      media: [{ path: stagedPath, contentType: "audio/wav" }],
    });
  });

  it("labels ordinary audio as attachment audio without granting native voice semantics", async () => {
    const fixture = isoBmffFixture("soun");
    const stagedPath = await writeFixture("attached-audio.m4a", fixture);
    const coreRuntime = installRuntime({
      id: "attached-audio.m4a",
      path: stagedPath,
      size: fixture.byteLength,
      contentType: "audio/mp4",
    });
    mockAuthenticatedSource("attached-audio.m4a");

    await handleNextcloudTalkInbound({
      message: createMessage("attached-audio.m4a", "audio/mp4", "inspect this recording"),
      account: createAccount(),
      config,
      runtime: runtimeEnv(),
    });

    expect(requireBuildContextCall(coreRuntime)).toMatchObject({
      message: {
        rawBody: "inspect this recording",
        bodyForAgent: "inspect this recording",
        commandBody: "inspect this recording",
        sourceModality: "audio",
      },
      media: [{ path: stagedPath, contentType: "audio/mp4" }],
    });
  });

  it("keeps genuine attached video on the video path", async () => {
    const fixture = isoBmffFixture("soun", "vide");
    const stagedPath = await writeFixture("attached-video.mp4", fixture);
    const coreRuntime = installRuntime({
      id: "attached-video.mp4",
      path: stagedPath,
      size: fixture.byteLength,
      contentType: "video/mp4",
    });
    mockAuthenticatedSource("attached-video.mp4");

    await handleNextcloudTalkInbound({
      message: createMessage("attached-video.mp4", "video/mp4"),
      account: createAccount(),
      config,
      runtime: runtimeEnv(),
    });

    const context = requireBuildContextCall(coreRuntime);
    expect(context.message).not.toHaveProperty("sourceModality");
    expect(context.media).toEqual([{ path: stagedPath, contentType: "video/mp4" }]);
  });

  it.each([
    { label: "contains a video track", fixture: isoBmffFixture("soun", "vide") },
    { label: "has no verifiable audio track", fixture: isoBmffFixture() },
  ])("fails closed when an authenticated voice message $label", async ({ fixture }) => {
    const stagedPath = await writeFixture("contradictory-voice.mp4", fixture);
    const coreRuntime = installRuntime({
      id: "contradictory-voice.mp4",
      path: stagedPath,
      size: fixture.byteLength,
      contentType: "video/mp4",
    });
    mockAuthenticatedSource("contradictory-voice.mp4", "voice", "audio/mp4");

    await handleNextcloudTalkInbound({
      message: createMessage("contradictory-voice.mp4", "video/mp4"),
      account: createAccount(),
      config,
      runtime: runtimeEnv(),
    });

    expect(coreRuntime.channel.media.deleteMediaBuffer).toHaveBeenCalledWith(
      "contradictory-voice.mp4",
    );
    const context = requireBuildContextCall(coreRuntime);
    expect(context).not.toHaveProperty("media");
    expect(context.message).toMatchObject({
      bodyForAgent: "[Nextcloud Talk attachment unavailable]",
      sourceModality: "voice",
    });
  });

  it("deletes the canonical media id when cancellation races native voice staging", async () => {
    const fixture = isoBmffFixture("soun");
    const stagedPath = await writeFixture("cancelled-voice.mp3", fixture);
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    const coreRuntime = installRuntime({
      id: "cancelled-voice.mp3",
      path: stagedPath,
      size: fixture.byteLength,
      contentType: "video/mp4",
    });
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => {
      abortController.abort(abortReason);
      return {
        id: "cancelled-voice.mp3",
        path: stagedPath,
        size: fixture.byteLength,
        contentType: "video/mp4",
      };
    });
    mockAuthenticatedSource("cancelled-voice.mp3", "voice");

    await expect(
      handleNextcloudTalkInbound({
        message: createMessage("cancelled-voice.mp3", "audio/mpeg"),
        account: createAccount(),
        config,
        runtime: runtimeEnv(),
        turnAdoptionLifecycle: {
          abortSignal: abortController.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: vi.fn(),
        },
      }),
    ).rejects.toBe(abortReason);

    expect(coreRuntime.channel.media.deleteMediaBuffer).toHaveBeenCalledWith("cancelled-voice.m4a");
    expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
  });
});
