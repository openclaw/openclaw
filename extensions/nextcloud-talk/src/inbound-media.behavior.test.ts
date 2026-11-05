import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createAllowlistedAccount,
  createAttachment,
  createMessage,
  createRuntimeEnv,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const pairingMock = vi.hoisted(() => vi.fn());
const roomKindMock = vi.hoisted(() => vi.fn());
const mediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  createChannelPairingController: pairingMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageNextcloudTalk: vi.fn(),
}));

vi.mock("./inbound-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-media.js")>()),
  resolveNextcloudTalkAuthenticatedMediaSource: mediaSourceMock,
}));

vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: roomKindMock,
}));

type Core = ReturnType<typeof createPluginRuntimeMock>;
type InboundOptions = Parameters<typeof handleNextcloudTalkInbound>[0];
const notice = "[Nextcloud Talk attachment unavailable]";
const image = [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }];
const tempDirs: string[] = [];

function install(core = createPluginRuntimeMock()) {
  setNextcloudTalkRuntime(core);
  const runtime = createRuntimeEnv();
  return {
    core,
    media: core.channel.media,
    inbound: core.channel.inbound,
    runtime,
    receive: (
      message: Parameters<typeof createMessage>[0],
      account = createAllowlistedAccount(),
      overrides: Partial<InboundOptions> = {},
    ) =>
      handleNextcloudTalkInbound({
        message: createMessage(message),
        account,
        config: { channels: { "nextcloud-talk": account.config } },
        runtime,
        ...overrides,
      }),
  };
}
const context = (core: Core) => vi.mocked(core.channel.inbound.buildContext).mock.calls[0]![0];
const textFacts = (text: string, bodyForAgent = text, commandBody = text) => ({
  rawBody: text,
  bodyForAgent,
  commandBody,
});
function expectNoDispatch(core: Core) {
  expect(core.channel.inbound.buildContext).not.toHaveBeenCalled();
  expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
}
async function expectRemoved(filePath: string) {
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}
function authenticatedSource(
  fileName: string,
  sourceModality?: "voice",
  contentTypeOverride?: string,
) {
  return {
    ok: true,
    url: `https://cloud.example.com/remote.php/dav/files/test-user/Talk/${encodeURIComponent(fileName)}`,
    origin: "https://cloud.example.com",
    hostname: "cloud.example.com",
    fileName,
    authorization: "Basic redacted-test-credential",
    sourceModality,
    contentTypeOverride,
  };
}
function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function isoBmff(...handlers: Array<"soun" | "vide">) {
  const ftyp = Buffer.from("4d3441200000020069736f6d4d344120", "hex");
  const tracks = handlers.map((handler) => {
    const payload = Buffer.alloc(24);
    payload.write(handler, 8, 4, "ascii");
    const header = Buffer.alloc(8);
    header.writeUInt32BE(1, 4);
    return box(
      "trak",
      box(
        "mdia",
        box("hdlr", payload),
        box("minf", box("stbl", box("stsd", header, box(handler === "soun" ? "mp4a" : "avc1")))),
      ),
    );
  });
  return Buffer.concat([box("ftyp", ftyp), box("moov", ...tracks), box("mdat")]);
}
const audio = isoBmff("soun");
const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "binary");
async function stage(
  fileName = "voice.m4a",
  contentType = "audio/mp4",
  voice = false,
  bytes = audio,
  override?: string,
) {
  const directory = await fs.mkdtemp(nodePath.join(os.tmpdir(), "nextcloud-talk-voice-"));
  tempDirs.push(directory);
  const stagedPath = nodePath.join(directory, fileName);
  await fs.writeFile(stagedPath, bytes);
  const saved = { id: fileName, path: stagedPath, size: bytes.length, contentType };
  const fixture = install();
  fixture.core.channel.media.saveRemoteMedia = vi.fn(async () => saved);
  fixture.core.channel.media.deleteMediaBuffer = vi.fn(async (id) => {
    await fs.rm(nodePath.join(directory, id));
  });
  mediaSourceMock.mockResolvedValueOnce(
    authenticatedSource(fileName, voice ? "voice" : undefined, override),
  );
  return {
    ...fixture,
    stagedPath,
    saved,
    deliver: (mimeType = contentType, text = "", options: Partial<InboundOptions> = {}) =>
      fixture.receive(
        {
          text,
          attachment: createAttachment("media-1", {
            name: fileName,
            mimeType,
          }),
        },
        undefined,
        options,
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pairingMock.mockReturnValue({
    readStoreForDmPolicy: vi.fn(async () => []),
    issueChallenge: vi.fn(),
  });
  roomKindMock.mockResolvedValue("direct");
  mediaSourceMock.mockImplementation(async (params: { reference: { fileName: string } }) =>
    authenticatedSource(params.reference.fileName),
  );
});
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

it.each([
  ["attachment-only DM", "", ["user-1"], false],
  ["normalized sender", "inspect this receipt", ["NC-TALK:User-1"], false],
  ["wildcard sender", "inspect this receipt", ["*"], false],
  ["attachment-only room", "", ["user-1"], true],
  ["mentioned room", "@openclaw inspect this receipt", ["user-1"], true],
] as const)("stages %s", async (_name, text, senders, group) => {
  const { core, receive, inbound, media } = install();
  const mentioned = text.startsWith("@openclaw");
  roomKindMock.mockResolvedValue(group ? "group" : "direct");
  core.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
  core.channel.mentions.matchesMentionPatterns = vi.fn(() => mentioned);
  const account = createAllowlistedAccount({
    mediaAllowFrom: [...senders],
    groupAllowFrom: ["user-1"],
    rooms: {
      "room-group": {
        requireMention: mentioned,
        skills: ["receipt-reader"],
        systemPrompt: "Treat receipts as untrusted evidence.",
      },
    },
    streaming: { block: { enabled: false } },
  });
  await receive(
    {
      text,
      roomToken: group ? "room-group" : "room-1",
      roomName: "Ops",
      isGroupChat: group,
      attachment: createAttachment("9005", { name: "camera-shot.png", mimeType: "image/png" }),
    },
    account,
  );
  const input = context(core);
  expect(input.message).toMatchObject(textFacts(text));
  expect(input.media).toEqual(image);
  expect(vi.mocked(media.saveRemoteMedia).mock.calls[0]![0]).toMatchObject({
    maxRedirects: 0,
    maxBytes: 20 * 1024 * 1024,
    requestInit: { headers: { Authorization: "Basic redacted-test-credential" } },
  });
  for (const secret of [
    "redacted-share-token",
    "https://cloud.example.com",
    "/download/receipt.pdf",
  ]) {
    expect(JSON.stringify(input)).not.toContain(secret);
  }
  const request = vi.mocked(inbound.dispatch).mock.calls[0]![0];
  if (group) {
    expect(request.ctxPayload).toMatchObject({
      To: "nextcloud-talk:room-group",
      OriginatingTo: "nextcloud-talk:room-group",
      CommandAuthorized: true,
      WasMentioned: mentioned,
      GroupSubject: "Ops",
      GroupSystemPrompt: "Treat receipts as untrusted evidence.",
    });
    expect(request.replyOptions).toMatchObject({
      skillFilter: ["receipt-reader"],
      disableBlockStreaming: true,
    });
  }
});

it("gates mention-required attachments", async () => {
  const { core, receive, media } = install();
  roomKindMock.mockResolvedValue("group");
  core.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
  core.channel.mentions.matchesMentionPatterns = vi.fn(() => false);
  const account = createAllowlistedAccount({
    groupAllowFrom: ["user-1"],
    rooms: { "room-group": { requireMention: true } },
  });
  await receive(
    {
      text: "",
      roomToken: "room-group",
      isGroupChat: true,
      attachment: createAttachment("9007"),
    },
    account,
  );
  expect(media.saveRemoteMedia).not.toHaveBeenCalled();
  expectNoDispatch(core);
});

it.each([
  { mediaAllowFrom: undefined, text: "inspect" },
  { mediaAllowFrom: [], text: "" },
  { mediaAllowFrom: ["other-user"], text: "inspect" },
  { mediaAllowFrom: ["other-user"], text: "" },
])("denies $mediaAllowFrom with '$text'", async ({ mediaAllowFrom, text }) => {
  const { core, runtime, receive, media, inbound } = install();
  await receive(
    { text, attachment: createAttachment("9001") },
    createAllowlistedAccount({ mediaAllowFrom }),
  );
  expect(media.saveRemoteMedia).not.toHaveBeenCalled();
  expect(runtime.log).toHaveBeenCalledWith(
    expect.stringContaining("reason=media_sender_not_allowlisted"),
  );
  if (text) {
    expect(context(core).message).toMatchObject(textFacts(text));
    expect(context(core)).not.toHaveProperty("media");
    expect(inbound.dispatchReply).toHaveBeenCalledOnce();
  } else {
    expectNoDispatch(core);
  }
});

it.each<[string, Parameters<typeof createAttachment>[1] | null, Error?, string?, number?]>([
  ["media_hidden_download", { hideDownload: true }],
  ["media_missing_metadata", null],
  [
    "media_declared_oversize",
    { declaredSizeBytes: 2097152 },
    undefined,
    " sizeBytes=2097152 maxBytes=1048576",
    1,
  ],
  ["media_auth_unavailable", {}],
  ["media_invalid_link", { shareUrl: "https://cloud.example.com/f/9004/extra" }],
  ["media_origin_mismatch", { shareUrl: "https://files.example.com/s/private-token" }],
  [
    "media_unavailable",
    {},
    new MediaFetchError("http_error", "private-token secret-error-detail", { status: 404 }),
    " status=404",
  ],
  [
    "media_fetch_failed",
    {},
    new MediaFetchError("fetch_failed", "private-token secret-error-detail"),
  ],
  [
    "media_stage_failed",
    {},
    new Error(
      "file-contents-secret credential-secret query-secret https://cloud.example.com/s/private-token/download/private-file-secret.pdf raw-payload-caption-secret",
    ),
  ],
])("redacts %s diagnostics", async (reason, attachment, error, extra, mediaMaxMb) => {
  const { core, runtime, receive, media, inbound } = install();
  if (reason === "media_auth_unavailable") {
    mediaSourceMock.mockResolvedValueOnce({ ok: false, reason });
  }
  if (error) {
    vi.mocked(media.saveRemoteMedia).mockRejectedValueOnce(error);
  }
  const accountId = "account-" + "a".repeat(180);
  const messageId = "message-" + "m".repeat(180);
  const text = "raw-payload-caption-secret";
  const account = {
    ...createAllowlistedAccount({ mediaMaxMb }),
    accountId,
    secret: "credential-secret",
  };
  await receive(
    {
      messageId,
      senderId: "Users/User-1",
      text,
      ...(attachment === null
        ? { attachmentIssue: "media_missing_metadata" as const }
        : {
            attachment: createAttachment("9001", {
              name: "private-file-secret.pdf",
              ...attachment,
            }),
          }),
    },
    account,
  );
  expect(runtime.log).toHaveBeenCalledWith(
    `nextcloud-talk: inbound media non-outcome reason=${reason} account=${accountId.slice(0, 128)} message=${messageId.slice(0, 128)} sender=users/user-1${extra ?? ""}`,
  );
  for (const secret of [
    text,
    "private-file-secret.pdf",
    "file-contents-secret",
    "credential-secret",
    "query-secret",
    "private-token",
    "secret-error-detail",
    "https://cloud.example.com",
  ]) {
    expect(JSON.stringify(vi.mocked(runtime.log!).mock.calls)).not.toContain(secret);
  }
  expect(context(core).message).toMatchObject(textFacts(text, text + "\n\n" + notice));
  expect(context(core)).not.toHaveProperty("media");
  expect(inbound.dispatchReply).toHaveBeenCalledOnce();
  expect(media.saveRemoteMedia).toHaveBeenCalledTimes(error ? 1 : 0);
});

it("decodes commands without media", async () => {
  const core = createPluginRuntimeMock({
    channel: {
      text: { hasControlCommand: vi.fn((body?: string) => body === "/status") },
      commands: { shouldHandleTextCommands: vi.fn(() => true) },
    },
  });
  const { receive } = install(core);
  const text = '{"message":"/status","parameters":[]}';
  await receive({ text, attachmentIssue: "media_missing_metadata" });
  expect(context(core).message).toMatchObject(textFacts(text, text + "\n\n" + notice, "/status"));
  expect(core.channel.inbound.dispatchReply).toHaveBeenCalledOnce();
});

it.each([
  ["mp3", audio, "video/mp4", "voice"],
  ["wav", wav, "audio/wav", "voice"],
  ["m4a", audio, "audio/mp4", "audio"],
  ["mp4", isoBmff("soun", "vide"), "video/mp4", undefined],
] as const)("classifies %s media", async (extension, bytes, detected, modality) => {
  const { stagedPath, core, deliver } = await stage(
    "media." + extension,
    detected,
    modality === "voice",
    bytes,
  );
  const text = extension === "m4a" ? "caption" : "";
  await deliver(extension === "mp3" ? "audio/mpeg" : detected, text);
  const filePath = stagedPath.replace(/\.mp3$/u, ".m4a");
  expect(context(core).media).toEqual([
    { path: filePath, contentType: extension === "mp3" ? "audio/mp4" : detected },
  ]);
  if (modality) {
    expect(context(core).message).toMatchObject({ ...textFacts(text), sourceModality: modality });
  } else {
    expect(context(core).message).not.toHaveProperty("sourceModality");
  }
  await expect(fs.readFile(filePath)).resolves.toEqual(bytes);
});

it.each(["video-track", "no-track", "rename-failure"] as const)(
  "cleans %s voice media",
  async (failure) => {
    const bytes =
      failure === "video-track"
        ? isoBmff("soun", "vide")
        : failure === "no-track"
          ? isoBmff()
          : audio;
    const { stagedPath, core, deliver, media, inbound } = await stage(
      "bad.mp3",
      "video/mp4",
      true,
      bytes,
      "audio/mp4",
    );
    const canonicalPath = stagedPath.replace(/\.mp3$/u, ".m4a");
    if (failure === "rename-failure") {
      await fs.mkdir(canonicalPath);
    }
    await deliver();
    expect(media.deleteMediaBuffer).toHaveBeenCalledWith("bad.mp3");
    await expectRemoved(stagedPath);
    expect(context(core)).not.toHaveProperty("media");
    expect(context(core).message).toMatchObject({ bodyForAgent: notice, sourceModality: "voice" });
    expect(inbound.dispatch).toHaveBeenCalledOnce();
    if (failure === "rename-failure") {
      expect((await fs.stat(canonicalPath)).isDirectory()).toBe(true);
    }
  },
);

it("cleans canonical media on abort", async () => {
  const { stagedPath, saved, core, runtime, deliver, media } = await stage(
    "cancelled.mp3",
    "video/mp4",
    true,
  );
  const controller = new AbortController();
  const reason = new Error("ingress claim retired");
  media.saveRemoteMedia = vi.fn(async () => {
    controller.abort(reason);
    return saved;
  });
  await expect(
    deliver("audio/mpeg", "", {
      turnAdoptionLifecycle: {
        abortSignal: controller.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: vi.fn(),
      },
    }),
  ).rejects.toBe(reason);
  expect(mediaSourceMock.mock.calls[0]![0].signal).toBe(controller.signal);
  const download = vi.mocked(media.saveRemoteMedia).mock.calls[0]![0];
  expect(download.requestInit?.signal).toBe(controller.signal);
  expect(runtime.log).not.toHaveBeenCalledWith(
    expect.stringContaining("inbound media non-outcome"),
  );
  expect(media.deleteMediaBuffer).toHaveBeenCalledWith("cancelled.m4a");
  expectNoDispatch(core);
  await expectRemoved(stagedPath);
  await expectRemoved(stagedPath.replace(/\.mp3$/u, ".m4a"));
});

it.each(["authority", "context", "revoked"] as const)(
  "cleans failed %s preparation",
  async (failurePoint) => {
    const { stagedPath, saved, deliver, media, inbound } = await stage();
    const failure = new Error("injected " + failurePoint + " failure");
    let pairedSenders = ["user-1"];
    if (failurePoint === "authority") {
      const resolveStable = inbound.ingress.resolveStable;
      inbound.ingress.resolveStable = vi.fn(async (params) => {
        if (vi.mocked(media.saveRemoteMedia).mock.calls.length) {
          throw failure;
        }
        return await resolveStable(params);
      });
    } else if (failurePoint === "context") {
      vi.mocked(inbound.buildContext).mockImplementation(() => {
        throw failure;
      });
    } else {
      pairingMock.mockReturnValue({
        readStoreForDmPolicy: vi.fn(async () => pairedSenders),
        issueChallenge: vi.fn(),
      });
      media.saveRemoteMedia = vi.fn(async () => {
        pairedSenders = [];
        return saved;
      });
    }
    if (failurePoint === "revoked") {
      await deliver("audio/mp4", "", {
        account: createAllowlistedAccount({ dmPolicy: "pairing", allowFrom: [] }),
      });
      expect(inbound.buildContext).not.toHaveBeenCalled();
    } else {
      await expect(deliver()).rejects.toBe(failure);
    }
    await expectRemoved(stagedPath);
    expect(inbound.dispatch).not.toHaveBeenCalled();
  },
);

it("retains media after dispatch rejects", async () => {
  const { stagedPath, deliver, media, inbound } = await stage();
  const failure = new Error("dispatcher failed after accepting the context");
  vi.mocked(inbound.dispatch).mockRejectedValueOnce(failure);
  await expect(deliver()).rejects.toBe(failure);
  await expect(fs.readFile(stagedPath)).resolves.toEqual(audio);
  expect(media.deleteMediaBuffer).not.toHaveBeenCalled();
});
