import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createAllowlistedAccount as createAccount,
  createAttachment,
  createMessage as baseMessage,
  createRuntimeEnv as runtimeEnv,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

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

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  createChannelPairingController: createChannelPairingControllerMock,
  resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
}));

vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveNextcloudTalkAuthenticatedMediaSource: resolveNextcloudTalkAuthenticatedMediaSourceMock,
}));

vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: vi.fn(async () => "direct"),
}));

function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.byteLength + payload.byteLength, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function trackBox(handlerType: "soun" | "vide"): Buffer {
  const payload = Buffer.alloc(24);
  payload.write(handlerType, 8, 4, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1, 4);
  const description = box("stsd", header, box(handlerType === "soun" ? "mp4a" : "avc1"));
  return box("trak", box("mdia", box("hdlr", payload), box("minf", box("stbl", description))));
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

function createMessage(fileName: string, mimeType: string, text = "") {
  return baseMessage({
    messageId: "msg-voice",
    text,
    attachment: createAttachment("media-1", {
      name: fileName,
      mimeType,
      declaredSizeBytes: 4_096,
    }),
  });
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

function requireBuildContextCall(coreRuntime: ReturnType<typeof createPluginRuntimeMock>) {
  const call = (coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!call) {
    throw new Error("expected Nextcloud Talk inbound context");
  }
  return call[0];
}

const config = { channels: { "nextcloud-talk": {} } } as CoreConfig;
const tempDirs: string[] = [];

async function stage(fileName: string, fixture: Buffer, contentType: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextcloud-talk-voice-"));
  tempDirs.push(directory);
  const stagedPath = path.join(directory, fileName);
  await fs.writeFile(stagedPath, fixture);
  const saved = { id: fileName, path: stagedPath, size: fixture.byteLength, contentType };
  const coreRuntime = createPluginRuntimeMock();
  coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => saved);
  coreRuntime.channel.media.deleteMediaBuffer = vi.fn(async (id) => {
    await fs.rm(path.join(directory, id));
  });
  setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
  const deliver = (
    mimeType = contentType,
    text = "",
    overrides: Partial<Parameters<typeof handleNextcloudTalkInbound>[0]> = {},
  ) =>
    handleNextcloudTalkInbound({
      message: createMessage(fileName, mimeType, text),
      account: createAccount(),
      config,
      runtime: runtimeEnv(),
      ...overrides,
    });
  return { stagedPath, saved, coreRuntime, deliver };
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
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([
    { label: "Android", detectedType: "video/mp4" },
    { label: "iPad", detectedType: "audio/x-m4a" },
  ])(
    "canonicalizes authenticated $label audio-only MP4 voice media for downstream speech",
    async ({ detectedType }) => {
      const fixture = isoBmffFixture("soun");
      const { coreRuntime, deliver } = await stage("native-voice.mp3", fixture, detectedType);
      mockAuthenticatedSource("native-voice.mp3", "voice");

      await deliver("audio/mpeg");

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
    const { stagedPath, coreRuntime, deliver } = await stage("native-voice.wav", wav, "audio/wav");
    mockAuthenticatedSource("native-voice.wav", "voice");

    await deliver();

    expect(requireBuildContextCall(coreRuntime)).toMatchObject({
      message: { sourceModality: "voice" },
      media: [{ path: stagedPath, contentType: "audio/wav" }],
    });
  });

  it("labels ordinary audio as attachment audio without granting native voice semantics", async () => {
    const fixture = isoBmffFixture("soun");
    const { stagedPath, coreRuntime, deliver } = await stage(
      "attached-audio.m4a",
      fixture,
      "audio/mp4",
    );
    mockAuthenticatedSource("attached-audio.m4a");

    await deliver("audio/mp4", "inspect this recording");

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
    const { stagedPath, coreRuntime, deliver } = await stage(
      "attached-video.mp4",
      fixture,
      "video/mp4",
    );
    mockAuthenticatedSource("attached-video.mp4");

    await deliver();

    const context = requireBuildContextCall(coreRuntime);
    expect(context.message).not.toHaveProperty("sourceModality");
    expect(context.media).toEqual([{ path: stagedPath, contentType: "video/mp4" }]);
  });

  it.each([
    { label: "contains a video track", fixture: isoBmffFixture("soun", "vide") },
    { label: "has no verifiable audio track", fixture: isoBmffFixture() },
  ])("fails closed when an authenticated voice message $label", async ({ fixture }) => {
    const { stagedPath, coreRuntime, deliver } = await stage(
      "contradictory-voice.mp4",
      fixture,
      "video/mp4",
    );
    mockAuthenticatedSource("contradictory-voice.mp4", "voice", "audio/mp4");

    await deliver();

    expect(coreRuntime.channel.media.deleteMediaBuffer).toHaveBeenCalledWith(
      "contradictory-voice.mp4",
    );
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const context = requireBuildContextCall(coreRuntime);
    expect(context).not.toHaveProperty("media");
    expect(context.message).toMatchObject({
      bodyForAgent: "[Nextcloud Talk attachment unavailable]",
      sourceModality: "voice",
    });
  });

  it("deletes the canonical media id when cancellation races native voice staging", async () => {
    const fixture = isoBmffFixture("soun");
    const { stagedPath, saved, coreRuntime, deliver } = await stage(
      "cancelled-voice.mp3",
      fixture,
      "video/mp4",
    );
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => {
      abortController.abort(abortReason);
      return saved;
    });
    mockAuthenticatedSource("cancelled-voice.mp3", "voice");

    await expect(
      deliver("audio/mpeg", "", {
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
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedPath.replace(/\.mp3$/u, ".m4a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retires the original staged file when voice canonicalization cannot rename it", async () => {
    const fixture = isoBmffFixture("soun");
    const { stagedPath, coreRuntime, deliver } = await stage(
      "rename-failure.mp3",
      fixture,
      "video/mp4",
    );
    const canonicalPath = stagedPath.replace(/\.mp3$/u, ".m4a");
    await fs.mkdir(canonicalPath);
    mockAuthenticatedSource("rename-failure.mp3", "voice");

    await deliver("audio/mpeg", "inspect this");

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(canonicalPath)).isDirectory()).toBe(true);
    const context = requireBuildContextCall(coreRuntime);
    expect(context).not.toHaveProperty("media");
    expect(context.message.bodyForAgent).toContain("attachment unavailable");
    expect(coreRuntime.channel.inbound.dispatch).toHaveBeenCalledOnce();
  });

  it.each(["authority", "context"] as const)(
    "retires staged media when final %s preparation throws",
    async (failurePoint) => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, coreRuntime, deliver } = await stage(
        "pre-dispatch.m4a",
        fixture,
        "audio/mp4",
      );
      const failure = new Error(`injected ${failurePoint} failure`);
      if (failurePoint === "authority") {
        const resolveStable = coreRuntime.channel.inbound.ingress.resolveStable;
        coreRuntime.channel.inbound.ingress.resolveStable = vi.fn(async (params) => {
          if (vi.mocked(coreRuntime.channel.media.saveRemoteMedia).mock.calls.length > 0) {
            throw failure;
          }
          return await resolveStable(params);
        });
      } else {
        vi.mocked(coreRuntime.channel.inbound.buildContext).mockImplementation(() => {
          throw failure;
        });
      }
      mockAuthenticatedSource("pre-dispatch.m4a");

      await expect(deliver()).rejects.toBe(failure);

      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
    },
  );

  it("retires staged media if the sender is revoked after storage", async () => {
    const fixture = isoBmffFixture("soun");
    const { stagedPath, saved, coreRuntime, deliver } = await stage(
      "revoked.m4a",
      fixture,
      "audio/mp4",
    );
    const account = createAccount({ dmPolicy: "pairing", allowFrom: [] });
    let pairedSenders = ["user-1"];
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => pairedSenders),
      issueChallenge: vi.fn(),
    });
    coreRuntime.channel.media.saveRemoteMedia = vi.fn(async () => {
      pairedSenders = [];
      return saved;
    });
    mockAuthenticatedSource("revoked.m4a");

    await deliver("audio/mp4", "", { account });

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not retire media after handing it to the dispatcher even if dispatch rejects", async () => {
    const fixture = isoBmffFixture("soun");
    const { stagedPath, coreRuntime, deliver } = await stage("adopted.m4a", fixture, "audio/mp4");
    const failure = new Error("dispatcher failed after accepting the context");
    vi.mocked(coreRuntime.channel.inbound.dispatch).mockRejectedValueOnce(failure);
    mockAuthenticatedSource("adopted.m4a");

    await expect(deliver()).rejects.toBe(failure);

    await expect(fs.readFile(stagedPath)).resolves.toEqual(fixture);
    expect(coreRuntime.channel.media.deleteMediaBuffer).not.toHaveBeenCalled();
  });
});
