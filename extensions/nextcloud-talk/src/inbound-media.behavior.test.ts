import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createAccount,
  createAllowlistedAccount,
  createAttachment,
  createMessage,
  createRuntimeEnv,
  requireFirstMockArg,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const { pairingMock, groupPolicyMock, defaultPolicyMock, warnFallbackMock } = vi.hoisted(() => ({
  pairingMock: vi.fn(),
  groupPolicyMock: vi.fn(),
  defaultPolicyMock: vi.fn(),
  warnFallbackMock: vi.fn(),
}));

const sendMock = vi.hoisted(() => vi.fn());
const roomKindMock = vi.hoisted(() => vi.fn());
const mediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  createChannelPairingController: pairingMock,
  resolveAllowlistProviderRuntimeGroupPolicy: groupPolicyMock,
  resolveDefaultGroupPolicy: defaultPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnce: warnFallbackMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageNextcloudTalk: sendMock,
}));

vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveNextcloudTalkAuthenticatedMediaSource: mediaSourceMock,
}));

vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: roomKindMock,
}));

function installInboundRuntime(core = createPluginRuntimeMock()) {
  setNextcloudTalkRuntime(core as unknown as PluginRuntime);
  const runtime = createRuntimeEnv();
  const receive = (
    message: Parameters<typeof createMessage>[0],
    account = createAllowlistedAccount(),
    config: CoreConfig = { channels: { "nextcloud-talk": {} } },
  ) =>
    handleNextcloudTalkInbound({
      message: createMessage(message),
      account,
      config,
      runtime,
    });
  return { core, runtime, receive };
}

function expectNonOutcome(
  runtime: ReturnType<typeof createRuntimeEnv>,
  reason: string,
  extra = "",
) {
  expect(runtime.log).toHaveBeenCalledWith(
    `nextcloud-talk: inbound media non-outcome reason=${reason} account=default message=msg-1 sender=users/user-1${extra}`,
  );
}

function mentionRoom(requireMention: boolean) {
  const core = createPluginRuntimeMock();
  core.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
  core.channel.mentions.matchesMentionPatterns = vi.fn(() => false);
  const result = installInboundRuntime(core);
  roomKindMock.mockResolvedValue("group");
  const channelConfig = { rooms: { "room-group": { requireMention } } };
  return {
    ...result,
    account: createAccount({
      config: {
        ...channelConfig,
        dmPolicy: "pairing",
        allowFrom: [],
        mediaAllowFrom: ["user-1"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-1"],
      },
    }),
    config: { channels: { "nextcloud-talk": channelConfig } },
  };
}

function expectTextContext(
  core: ReturnType<typeof createPluginRuntimeMock>,
  message: Record<string, unknown>,
  noMedia = true,
) {
  expect(core.channel.inbound.buildContext).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.objectContaining(message) }),
  );
  if (noMedia) {
    expect(
      requireFirstMockArg(vi.mocked(core.channel.inbound.buildContext), "buildContext"),
    ).not.toHaveProperty("media");
  }
}

function unavailableText(text: string) {
  return {
    bodyForAgent: `${text}\n\n[Nextcloud Talk attachment unavailable]`,
    rawBody: text,
    commandBody: text,
  };
}

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

function createVoiceMessage(fileName: string, mimeType: string, text = "") {
  return createMessage({
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
  mediaSourceMock.mockResolvedValueOnce({
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

function requireBuildContextCall(core: ReturnType<typeof createPluginRuntimeMock>) {
  const call = (core.channel.inbound.buildContext as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!call) {
    throw new Error("expected Nextcloud Talk inbound context");
  }
  return call[0];
}

const tempDirs: string[] = [];

async function stage(fileName: string, fixture: Buffer, contentType: string) {
  const directory = await fs.mkdtemp(nodePath.join(os.tmpdir(), "nextcloud-talk-voice-"));
  tempDirs.push(directory);
  const stagedPath = nodePath.join(directory, fileName);
  await fs.writeFile(stagedPath, fixture);
  const saved = { id: fileName, path: stagedPath, size: fixture.byteLength, contentType };
  const core = createPluginRuntimeMock();
  core.channel.media.saveRemoteMedia = vi.fn(async () => saved);
  core.channel.media.deleteMediaBuffer = vi.fn(async (id) => {
    await fs.rm(nodePath.join(directory, id));
  });
  setNextcloudTalkRuntime(core as unknown as PluginRuntime);
  const runtime = createRuntimeEnv();
  const deliver = (
    mimeType = contentType,
    text = "",
    overrides: Partial<Parameters<typeof handleNextcloudTalkInbound>[0]> = {},
  ) =>
    handleNextcloudTalkInbound({
      message: createVoiceMessage(fileName, mimeType, text),
      account: createAllowlistedAccount(),
      config: { channels: { "nextcloud-talk": {} } },
      runtime,
      ...overrides,
    });
  return { stagedPath, saved, core, runtime, deliver };
}

describe("nextcloud-talk inbound media behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pairingMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    roomKindMock.mockResolvedValue("direct");
    defaultPolicyMock.mockReturnValue("allowlist");
    groupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnFallbackMock.mockReturnValue(undefined);
    mediaSourceMock.mockImplementation(async (params: { reference: { fileName: string } }) => ({
      ok: true,
      url: `https://cloud.example.com/remote.php/dav/files/test-user/Talk/${encodeURIComponent(params.reference.fileName)}`,
      origin: "https://cloud.example.com",
      hostname: "cloud.example.com",
      fileName: params.reference.fileName,
      authorization: "Basic redacted-test-credential",
    }));
  });

  it("admits and stages an attachment-only direct message", async () => {
    const { core, receive } = installInboundRuntime();

    await receive({
      text: "",
      attachment: createAttachment("9006"),
    });

    expect(core.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(core.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "", rawBody: "" }),
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
  });

  it.each([true, false])("requires mention for attachment-only room: %s", async (required) => {
    const { core, runtime, account, config } = mentionRoom(required);
    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "",
        attachment: createAttachment("9007"),
      }),
      account,
      config,
      runtime,
    });
    if (required) {
      expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatchReply).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
    } else {
      expect(core.channel.media.saveRemoteMedia).toHaveBeenCalledOnce();
      expect(core.channel.inbound.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ bodyForAgent: "", rawBody: "", commandBody: "" }),
          media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
        }),
      );
      expect(core.channel.inbound.dispatchReply).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["omitted", undefined, "please inspect this receipt"],
    ["empty", [], "please inspect this receipt"],
    ["nonmatching", ["other-user"], "please inspect this receipt"],
    ["omitted", undefined, ""],
    ["empty", [], ""],
    ["nonmatching", ["other-user"], ""],
  ] as const)("denies %s media allowlist with caption %j", async (_label, mediaAllowFrom, text) => {
    const { core, runtime, receive } = installInboundRuntime();
    await receive(
      { text, attachment: createAttachment("9001", { declaredSizeBytes: 24_576 }) },
      createAllowlistedAccount({
        mediaAllowFrom: mediaAllowFrom ? [...mediaAllowFrom] : undefined,
      }),
    );
    expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expectNonOutcome(runtime, "media_sender_not_allowlisted");
    if (text) {
      expectTextContext(core, { bodyForAgent: text, rawBody: text });
      expect(
        JSON.stringify(
          requireFirstMockArg(vi.mocked(core.channel.inbound.buildContext), "media-denied context"),
        ),
      ).not.toContain("Nextcloud Talk attachment unavailable");
      expect(core.channel.inbound.dispatchReply).toHaveBeenCalledOnce();
    } else {
      expect(core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    }
  });

  it.each([
    { reason: "media_hidden_download", attachment: { hideDownload: true } },
    { reason: "media_missing_metadata", missingMetadata: true },
    {
      reason: "media_declared_oversize",
      attachment: { declaredSizeBytes: 2 * 1024 * 1024 },
      mediaMaxMb: 1,
      extra: " sizeBytes=2097152 maxBytes=1048576",
    },
    { reason: "media_auth_unavailable", lookupFailure: true },
    {
      reason: "media_invalid_link",
      attachment: { shareUrl: "https://cloud.example.com/f/9004/extra" },
    },
    {
      reason: "media_origin_mismatch",
      attachment: { shareUrl: "https://files.example.com/s/redacted-share-token" },
    },
    {
      reason: "media_unavailable",
      error: new MediaFetchError("http_error", "private-token secret-error-detail", {
        status: 404,
      }),
      extra: " status=404",
    },
    {
      reason: "media_fetch_failed",
      error: new MediaFetchError("fetch_failed", "private-token secret-error-detail"),
    },
    { reason: "media_stage_failed", error: new Error("private-token secret-error-detail") },
  ])(
    "preserves caption and bounded diagnostics for $reason",
    async ({ reason, attachment, missingMetadata, mediaMaxMb, extra, lookupFailure, error }) => {
      const { core, runtime, receive } = installInboundRuntime();
      if (lookupFailure) {
        mediaSourceMock.mockResolvedValueOnce({ ok: false, reason });
      }
      if (error) {
        vi.mocked(core.channel.media.saveRemoteMedia).mockRejectedValueOnce(error);
      }
      const text = "inspect this sensitive receipt";
      await receive(
        {
          text,
          ...(missingMetadata
            ? { attachmentIssue: "media_missing_metadata" as const }
            : { attachment: createAttachment("9001", attachment) }),
        },
        createAllowlistedAccount({ mediaMaxMb }),
      );
      if (error) {
        expect(core.channel.media.saveRemoteMedia).toHaveBeenCalledOnce();
      } else {
        expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      }
      expectNonOutcome(runtime, reason, extra);
      const logs = JSON.stringify(vi.mocked(runtime.log!).mock.calls);
      for (const secret of ["private-token", "secret-error-detail", text]) {
        expect(logs).not.toContain(secret);
      }
      expectTextContext(core, {
        ...unavailableText(text),
        body: expect.stringContaining("[Nextcloud Talk attachment unavailable]"),
      });
      expect(core.channel.inbound.dispatchReply).toHaveBeenCalledOnce();
    },
  );

  it("keeps structured commands decoded when authorized media is unavailable", async () => {
    const hasControlCommand = vi.fn((body?: string) => body === "/status");
    const core = createPluginRuntimeMock({
      channel: {
        text: { hasControlCommand },
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
      },
    });
    const { receive } = installInboundRuntime(core);
    const structuredCommand = '{"message":"/status","parameters":[]}';

    await receive({
      text: structuredCommand,
      attachmentIssue: "media_missing_metadata",
    });

    expect(hasControlCommand).toHaveBeenCalledWith("/status", expect.anything());
    expectTextContext(
      core,
      { ...unavailableText(structuredCommand), commandBody: "/status" },
      false,
    );
    expect(core.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("logs only bounded media diagnostics without sensitive attachment data", async () => {
    const accountId = `account-${"a".repeat(180)}`;
    const messageId = `message-${"m".repeat(180)}`;
    const senderId = "Users/Alice";
    const core = createPluginRuntimeMock();
    vi.mocked(core.channel.media.saveRemoteMedia).mockRejectedValueOnce(
      new Error(
        "file-contents-secret credential-secret query-secret " +
          "https://cloud.example.com/s/private-token/download/private-file-secret.pdf " +
          "raw-payload-caption-secret",
      ),
    );
    const { runtime, receive } = installInboundRuntime(core);

    await receive(
      {
        messageId,
        senderId,
        text: "raw-payload-caption-secret",
        attachment: createAttachment("9014", {
          name: "private-file-secret.pdf",
          shareUrl: "https://cloud.example.com/s/private-token",
        }),
      },
      createAccount({
        accountId,
        secret: "credential-secret",
        config: {
          dmPolicy: "allowlist",
          allowFrom: [senderId],
          mediaAllowFrom: [senderId],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
    );

    expect(runtime.log).toHaveBeenCalledWith(
      `nextcloud-talk: inbound media non-outcome reason=media_stage_failed account=${accountId.slice(0, 128)} message=${messageId.slice(0, 128)} sender=users/alice`,
    );
    const serializedLogs = JSON.stringify(
      (runtime.log as unknown as ReturnType<typeof vi.fn>).mock.calls,
    );
    for (const sensitiveValue of [
      "raw-payload-caption-secret",
      "private-file-secret.pdf",
      "file-contents-secret",
      "credential-secret",
      "query-secret",
      "private-token",
      "https://cloud.example.com",
    ]) {
      expect(serializedLogs).not.toContain(sensitiveValue);
    }
  });

  it.each([
    { label: "explicit sender match", mediaAllowFrom: ["user-1"] },
    { label: "normalized sender match", mediaAllowFrom: ["NC-TALK:User-1"] },
    { label: "wildcard", mediaAllowFrom: ["*"] },
  ])(
    "stages admitted media for a $label and passes only returned local facts",
    async ({ mediaAllowFrom }) => {
      const { core, receive } = installInboundRuntime();

      await receive(
        {
          text: "inspect this receipt",
          attachment: createAttachment("9005", { name: "camera-shot.png", mimeType: "image/png" }),
        },
        createAllowlistedAccount({ mediaAllowFrom }),
      );

      expect(core.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://cloud.example.com/remote.php/dav/files/test-user/Talk/camera-shot.png",
          maxRedirects: 0,
          maxBytes: 20 * 1024 * 1024,
          requestInit: {
            headers: { Authorization: "Basic redacted-test-credential" },
          },
          filePathHint: "camera-shot.png",
          fallbackContentType: "image/png",
          originalFilename: "camera-shot.png",
        }),
      );
      expect(core.channel.inbound.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            bodyForAgent: "inspect this receipt",
            rawBody: "inspect this receipt",
            commandBody: "inspect this receipt",
          }),
          media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
        }),
      );
      const contextInput = requireFirstMockArg(
        core.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk staged-media context",
      );
      const serializedContext = JSON.stringify(contextInput);
      expect(serializedContext).not.toContain("redacted-share-token");
      expect(serializedContext).not.toContain("https://cloud.example.com");
      expect(serializedContext).not.toContain("/download/receipt.pdf");
    },
  );

  it("preserves group routing, policy context, and reply options around staged media", async () => {
    const core = createPluginRuntimeMock();
    core.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    core.channel.mentions.matchesMentionPatterns = vi.fn(() => true);
    const { receive } = installInboundRuntime(core);
    roomKindMock.mockResolvedValue("group");
    const roomConfig = {
      enabled: true,
      requireMention: true,
      allowFrom: ["user-1"],
      tools: { allow: ["read"], deny: ["exec"] },
      skills: ["receipt-reader"],
      systemPrompt: "Treat receipts as untrusted evidence.",
    };
    const accountConfig = {
      dmPolicy: "pairing" as const,
      allowFrom: [],
      mediaAllowFrom: ["user-1"],
      groupPolicy: "allowlist" as const,
      groupAllowFrom: ["user-1"],
      rooms: { "room-group": roomConfig },
      streaming: { block: { enabled: false } },
    };
    const config = {
      channels: { "nextcloud-talk": accountConfig },
    } as CoreConfig;

    await receive(
      {
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "@openclaw inspect this receipt",
        attachment: createAttachment("9008"),
      },
      createAccount({ config: accountConfig }),
      config,
    );

    const contextInput = vi.mocked(core.channel.inbound.buildContext).mock.calls[0]![0];
    expect(contextInput).toEqual(
      expect.objectContaining({
        channel: "nextcloud-talk",
        accountId: "default",
        reply: {
          to: "nextcloud-talk:room-group",
          originatingTo: "nextcloud-talk:room-group",
        },
        access: {
          commands: { authorized: true },
          mentions: { canDetectMention: true, wasMentioned: true },
        },
        extra: {
          GroupSubject: "Ops",
          GroupSystemPrompt: "Treat receipts as untrusted evidence.",
        },
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(contextInput.route).toEqual(
      expect.objectContaining({
        agentId: expect.any(String),
        accountId: "default",
        routeSessionKey: expect.any(String),
      }),
    );

    const request = vi.mocked(core.channel.inbound.dispatch).mock.calls[0]![0];
    expect(request.accountId).toBe("default");
    expect(request.route).toEqual({
      agentId: contextInput.route?.agentId,
      sessionKey: contextInput.route?.routeSessionKey,
    });
    expect(request.replyPipeline).toEqual({});
    expect(request.replyOptions).toEqual(
      expect.objectContaining({
        skillFilter: ["receipt-reader"],
        disableBlockStreaming: true,
      }),
    );
    expect(request.record?.onRecordError).toEqual(expect.any(Function));
    expect(request.delivery).toEqual(
      expect.objectContaining({
        preparePayload: expect.any(Function),
        deliverWithProviderMessageSending: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });
  describe("native voice media", () => {
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
        const { core, deliver } = await stage("native-voice.mp3", fixture, detectedType);
        mockAuthenticatedSource("native-voice.mp3", "voice");

        await deliver("audio/mpeg");

        const context = requireBuildContextCall(core);
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
      const { stagedPath, core, deliver } = await stage("native-voice.wav", wav, "audio/wav");
      mockAuthenticatedSource("native-voice.wav", "voice");

      await deliver();

      expect(requireBuildContextCall(core)).toMatchObject({
        message: { sourceModality: "voice" },
        media: [{ path: stagedPath, contentType: "audio/wav" }],
      });
    });

    it("labels ordinary audio as attachment audio without granting native voice semantics", async () => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, core, deliver } = await stage("attached-audio.m4a", fixture, "audio/mp4");
      mockAuthenticatedSource("attached-audio.m4a");

      await deliver("audio/mp4", "inspect this recording");

      expect(requireBuildContextCall(core)).toMatchObject({
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
      const { stagedPath, core, deliver } = await stage("attached-video.mp4", fixture, "video/mp4");
      mockAuthenticatedSource("attached-video.mp4");

      await deliver();

      const context = requireBuildContextCall(core);
      expect(context.message).not.toHaveProperty("sourceModality");
      expect(context.media).toEqual([{ path: stagedPath, contentType: "video/mp4" }]);
    });

    it.each([
      { label: "contains a video track", fixture: isoBmffFixture("soun", "vide") },
      { label: "has no verifiable audio track", fixture: isoBmffFixture() },
    ])("fails closed when an authenticated voice message $label", async ({ fixture }) => {
      const { stagedPath, core, deliver } = await stage(
        "contradictory-voice.mp4",
        fixture,
        "video/mp4",
      );
      mockAuthenticatedSource("contradictory-voice.mp4", "voice", "audio/mp4");

      await deliver();

      expect(core.channel.media.deleteMediaBuffer).toHaveBeenCalledWith("contradictory-voice.mp4");
      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      const context = requireBuildContextCall(core);
      expect(context).not.toHaveProperty("media");
      expect(context.message).toMatchObject({
        bodyForAgent: "[Nextcloud Talk attachment unavailable]",
        sourceModality: "voice",
      });
    });

    it("deletes the canonical media id when cancellation races native voice staging", async () => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, saved, core, runtime, deliver } = await stage(
        "cancelled-voice.mp3",
        fixture,
        "video/mp4",
      );
      const abortController = new AbortController();
      const abortReason = new Error("ingress claim retired");
      core.channel.media.saveRemoteMedia = vi.fn(async () => {
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

      expect(mediaSourceMock).toHaveBeenCalledWith(
        expect.objectContaining({ signal: abortController.signal }),
      );
      expect(core.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          requestInit: expect.objectContaining({ signal: abortController.signal }),
        }),
      );
      expect(runtime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("inbound media non-outcome"),
      );
      expect(core.channel.media.deleteMediaBuffer).toHaveBeenCalledWith("cancelled-voice.m4a");
      expect(core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(stagedPath.replace(/\.mp3$/u, ".m4a"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("retires the original staged file when voice canonicalization cannot rename it", async () => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, core, deliver } = await stage("rename-failure.mp3", fixture, "video/mp4");
      const canonicalPath = stagedPath.replace(/\.mp3$/u, ".m4a");
      await fs.mkdir(canonicalPath);
      mockAuthenticatedSource("rename-failure.mp3", "voice");

      await deliver("audio/mpeg", "inspect this");

      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(canonicalPath)).isDirectory()).toBe(true);
      const context = requireBuildContextCall(core);
      expect(context).not.toHaveProperty("media");
      expect(context.message.bodyForAgent).toContain("attachment unavailable");
      expect(core.channel.inbound.dispatch).toHaveBeenCalledOnce();
    });

    it.each(["authority", "context"] as const)(
      "retires staged media when final %s preparation throws",
      async (failurePoint) => {
        const fixture = isoBmffFixture("soun");
        const { stagedPath, core, deliver } = await stage("pre-dispatch.m4a", fixture, "audio/mp4");
        const failure = new Error(`injected ${failurePoint} failure`);
        if (failurePoint === "authority") {
          const resolveStable = core.channel.inbound.ingress.resolveStable;
          core.channel.inbound.ingress.resolveStable = vi.fn(async (params) => {
            if (vi.mocked(core.channel.media.saveRemoteMedia).mock.calls.length > 0) {
              throw failure;
            }
            return await resolveStable(params);
          });
        } else {
          vi.mocked(core.channel.inbound.buildContext).mockImplementation(() => {
            throw failure;
          });
        }
        mockAuthenticatedSource("pre-dispatch.m4a");

        await expect(deliver()).rejects.toBe(failure);

        await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
      },
    );

    it("retires staged media if the sender is revoked after storage", async () => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, saved, core, deliver } = await stage("revoked.m4a", fixture, "audio/mp4");
      const account = createAllowlistedAccount({ dmPolicy: "pairing", allowFrom: [] });
      let pairedSenders = ["user-1"];
      pairingMock.mockReturnValue({
        readStoreForDmPolicy: vi.fn(async () => pairedSenders),
        issueChallenge: vi.fn(),
      });
      core.channel.media.saveRemoteMedia = vi.fn(async () => {
        pairedSenders = [];
        return saved;
      });
      mockAuthenticatedSource("revoked.m4a");

      await deliver("audio/mp4", "", { account });

      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(core.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
    });

    it("does not retire media after handing it to the dispatcher even if dispatch rejects", async () => {
      const fixture = isoBmffFixture("soun");
      const { stagedPath, core, deliver } = await stage("adopted.m4a", fixture, "audio/mp4");
      const failure = new Error("dispatcher failed after accepting the context");
      vi.mocked(core.channel.inbound.dispatch).mockRejectedValueOnce(failure);
      mockAuthenticatedSource("adopted.m4a");

      await expect(deliver()).rejects.toBe(failure);

      await expect(fs.readFile(stagedPath)).resolves.toEqual(fixture);
      expect(core.channel.media.deleteMediaBuffer).not.toHaveBeenCalled();
    });
  });
});
