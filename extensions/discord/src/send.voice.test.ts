// Discord tests cover send.voice plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "./internal/rest.js";

const loadWebMediaRawMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMediaRaw: loadWebMediaRawMock,
}));

const tempPathMocks = vi.hoisted(() => ({ rootDir: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => tempPathMocks.rootDir,
}));

const mediaMocks = vi.hoisted(() => ({
  probe: vi.fn<(args: string[]) => Promise<string>>(),
  ffmpeg: vi.fn<(args: string[]) => Promise<void>>(),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  runFfprobe: mediaMocks.probe,
  runFfmpeg: mediaMocks.ffmpeg,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: vi.fn(async ({ init }: { init?: RequestInit }) => ({
    response:
      init?.method === "POST"
        ? new Response(
            JSON.stringify({
              attachments: [
                { id: 0, upload_url: "https://cdn.test/voice", upload_filename: "uploaded.ogg" },
              ],
            }),
            { status: 200 },
          )
        : new Response(null, { status: 200 }),
    release: async () => {},
  })),
}));

function makeVoiceRest() {
  const rest = new RequestClient("t", {
    baseUrl: "https://discord.test/api/v10",
    queueRequests: false,
  });
  const postMock = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "msg1", channel_id: "273512430271856640" });
  return { rest, postMock };
}

const DISCORD_TEST_CFG = {
  channels: { discord: { token: "t" } },
};

let sendVoiceMessageDiscord: typeof import("./send.voice.js").sendVoiceMessageDiscord;

describe("sendVoiceMessageDiscord", () => {
  beforeAll(async () => {
    tempPathMocks.rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-discord-voice-send-"),
    );
    ({ sendVoiceMessageDiscord } = await import("./send.voice.js"));
  });

  afterAll(async () => {
    await fs.rm(tempPathMocks.rootDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadWebMediaRawMock.mockReset().mockResolvedValue({
      buffer: Buffer.from("voice"),
      fileName: "voice.ogg",
      contentType: "audio/ogg",
      kind: "audio",
    });
    mediaMocks.probe
      .mockReset()
      .mockImplementation(async (args) =>
        args.includes("stream=codec_name,sample_rate") ? "opus,48000\n" : "1\n",
      );
    mediaMocks.ffmpeg.mockReset().mockImplementation(async (args) => {
      const output = args.at(-1);
      if (!output) {
        throw new Error("Missing waveform output");
      }
      await fs.writeFile(output, Buffer.alloc(512));
    });
  });

  it("cleans materialized voice media when pre-send conversion fails", async () => {
    const { rest } = makeVoiceRest();
    mediaMocks.probe.mockRejectedValueOnce(new Error("codec probe unavailable"));
    mediaMocks.ffmpeg.mockRejectedValueOnce(new Error("ffmpeg unavailable"));

    await expect(
      sendVoiceMessageDiscord("273512430271856640", "https://example.com/voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
      }),
    ).rejects.toThrow("ffmpeg unavailable");

    await expect(fs.readdir(tempPathMocks.rootDir)).resolves.toEqual([]);
  });

  it("records the native reply target in voice receipts", async () => {
    const { rest, postMock } = makeVoiceRest();

    const result = await sendVoiceMessageDiscord(
      "273512430271856640",
      "https://example.com/voice.ogg",
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        reply: { messageId: "reply-1", scope: "first" },
      },
    );

    expect(result.channelId).toBe("273512430271856640");
    expect(postMock).toHaveBeenCalledExactlyOnceWith("/channels/273512430271856640/messages", {
      body: expect.objectContaining({
        attachments: [
          expect.objectContaining({
            duration_secs: 1,
            waveform: Buffer.alloc(256).toString("base64"),
          }),
        ],
        message_reference: { message_id: "reply-1", fail_if_not_exists: false },
      }),
    });
    expect(result.receipt.replyToId).toBe("reply-1");
    expect(result.receipt.parts[0]?.replyToId).toBe("reply-1");
  });

  it("rechecks live authority after the awaited dispatch callback before creating a message", async () => {
    const { rest, postMock } = makeVoiceRest();
    let authorized = true;
    await expect(
      sendVoiceMessageDiscord("273512430271856640", "https://example.com/voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        retry: { attempts: 1 },
        onPlatformSendDispatch: async () => {
          authorized = false;
        },
        assertPlatformSendAuthorized: () => {
          if (!authorized) {
            throw new Error("voice send authority revoked");
          }
        },
      }),
    ).rejects.toThrow("voice send authority revoked");
    expect(postMock).not.toHaveBeenCalled();
    await expect(fs.readdir(tempPathMocks.rootDir)).resolves.toEqual([]);
  });

  it("reads relative voice files from the trusted reader-free workspace without widening its roots", async () => {
    const fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-voice-")),
    );
    const workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "voice.ogg"), Buffer.from("OggS trusted voice"));
    await fs.writeFile(path.join(fixtureRoot, "outside.ogg"), Buffer.from("OggS outside voice"));
    const mediaAccess = { localRoots: [workspaceDir], workspaceDir };
    const { loadWebMediaRaw } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/web-media")
    >("openclaw/plugin-sdk/web-media");
    loadWebMediaRawMock.mockImplementation(loadWebMediaRaw);
    const { rest, postMock } = makeVoiceRest();

    try {
      await sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaAccess,
      });

      const [, loaderOptions] = loadWebMediaRawMock.mock.calls[0] ?? [];
      expect(loaderOptions).toMatchObject({ localRoots: mediaAccess.localRoots, workspaceDir });
      expect(loaderOptions.localRoots).toBe(mediaAccess.localRoots);
      expect(loaderOptions).not.toHaveProperty("readFile");
      expect(loaderOptions).not.toHaveProperty("hostReadCapability");
      expect(postMock).toHaveBeenCalledTimes(1);

      await expect(
        sendVoiceMessageDiscord("273512430271856640", "../outside.ogg", {
          cfg: DISCORD_TEST_CFG,
          rest,
          token: "t",
          mediaAccess,
        }),
      ).rejects.toThrow(/not under an allowed directory/i);
      expect(postMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(["canonical", "split"] as const)(
    "preserves the trusted %s host reader and its explicit roots",
    async (capabilityShape) => {
      const mediaLocalRoots = ["/tmp/agent-workspace"];
      const mediaReadFile = vi.fn(async () => Buffer.from("trusted voice"));
      const mediaAccess = {
        localRoots: mediaLocalRoots,
        readFile: mediaReadFile,
        workspaceDir: "/tmp/agent-workspace",
      };
      const { rest } = makeVoiceRest();

      await sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        ...(capabilityShape === "canonical" ? { mediaAccess } : { mediaLocalRoots, mediaReadFile }),
      });

      const [, loaderOptions] = loadWebMediaRawMock.mock.calls[0] ?? [];
      expect(loaderOptions.localRoots).toBe(mediaLocalRoots);
      expect(loaderOptions.readFile).toBe(mediaReadFile);
      expect(loaderOptions.hostReadCapability).toBe(true);
      if (capabilityShape === "canonical") {
        expect(loaderOptions.workspaceDir).toBe(mediaAccess.workspaceDir);
      } else {
        expect(loaderOptions).not.toHaveProperty("workspaceDir");
      }
    },
  );

  it("rejects a trusted host reader that has no explicit root boundary", async () => {
    const { rest } = makeVoiceRest();

    await expect(
      sendVoiceMessageDiscord("273512430271856640", "./voice.ogg", {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        mediaReadFile: vi.fn(async () => Buffer.from("voice")),
      }),
    ).rejects.toThrow(/Host media read requires explicit localRoots/i);
    expect(loadWebMediaRawMock).not.toHaveBeenCalled();
  });
});
