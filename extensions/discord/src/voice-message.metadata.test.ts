import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
  root: "",
  probe: vi.fn<(args: string[]) => Promise<string>>(),
  waveform: vi.fn<(args: string[]) => Promise<string>>(),
  onCleanup: () => {},
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => media.root,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    runFfprobe: media.probe,
    runFfmpeg: media.waveform,
    unlinkIfExists: (filePath: string | null | undefined) => {
      const cleanup = actual.unlinkIfExists(filePath);
      void cleanup.then(() => media.onCleanup());
      return cleanup;
    },
  };
});

vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMediaRaw: vi.fn(async (source: string) => ({
    buffer: await fs.readFile(source),
    fileName: "original.ogg",
    contentType: "audio/ogg",
    kind: "audio",
  })),
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

import { RequestClient } from "./internal/rest.js";
import { sendVoiceMessageDiscord } from "./send.voice.js";

const requireRecord = createRequireRecord("object", "expected-label");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  media.root = tempDirs.make("discord-voice-metadata-");
  media.probe.mockReset();
  media.waveform.mockReset();
  media.onCleanup = () => {};
});

async function arrangeMetadata(waveformFails = false) {
  const inputPath = path.join(media.root, "original.ogg");
  const original = Buffer.from("caller-owned audio input");
  await fs.writeFile(inputPath, original);
  const probe = createDeferred<string>();
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const cleaned = createDeferred<void>();
  media.onCleanup = () => cleaned.resolve();
  media.probe.mockImplementation((args) =>
    args.includes("stream=codec_name,sample_rate")
      ? Promise.resolve("opus,48000\n")
      : probe.promise,
  );
  media.waveform.mockImplementation(async (args) => {
    const outputPath = args.at(-1);
    if (!outputPath) {
      throw new Error("Missing waveform output path");
    }
    started.resolve();
    await release.promise;
    if (waveformFails) {
      throw new Error("waveform conversion failed");
    }
    const pcm = Buffer.alloc(6);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(1_000, offset);
    }
    await fs.writeFile(outputPath, pcm);
    return "";
  });
  const rest = new RequestClient("bot-token", {
    baseUrl: "https://discord.test/api/v10",
    queueRequests: false,
  });
  const post = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "msg-1", channel_id: "273512430271856640" });
  let settled = false;
  const outcome = sendVoiceMessageDiscord("273512430271856640", inputPath, {
    cfg: { channels: { discord: { token: "bot-token" } } },
    rest,
    token: "bot-token",
  }).then(
    (value) => {
      settled = true;
      return { value, error: undefined };
    },
    (error: unknown) => {
      settled = true;
      return { value: undefined, error };
    },
  );
  return {
    inputPath,
    original,
    post,
    probe,
    started: started.promise,
    release,
    cleaned: cleaned.promise,
    outcome,
    isSettled: () => settled,
  };
}

describe("public voice send owns waveform cleanup", () => {
  it("joins waveform cleanup before reporting duration cancellation", async () => {
    const fixture = await arrangeMetadata();
    const probeError = Object.assign(new Error("duration cancellation"), {
      signal: "SIGTERM",
    });
    let settledBeforeWaveformRelease = false;
    try {
      await fixture.started;
      expect(media.waveform).toHaveBeenCalledOnce();
      fixture.probe.reject(probeError);
      await setImmediate();
      settledBeforeWaveformRelease = fixture.isSettled();
    } finally {
      fixture.probe.resolve("1.25\n");
      fixture.release.resolve();
      await fixture.cleaned;
      await fixture.outcome;
    }

    const result = await fixture.outcome;
    expect(result.error).toMatchObject({
      message: "Failed to get audio duration: duration cancellation",
      cause: probeError,
    });
    expect(await fs.readFile(fixture.inputPath)).toEqual(fixture.original);
    expect(await fs.readdir(media.root)).toEqual(["original.ogg"]);
    expect(settledBeforeWaveformRelease).toBe(false);
  });

  it.each([false, true])(
    "returns usable metadata after waveform failure=%s and cleanup",
    async (waveformFails) => {
      const fixture = await arrangeMetadata(waveformFails);
      try {
        await fixture.started;
        expect(media.waveform).toHaveBeenCalledOnce();
        fixture.probe.resolve("1.25\n");
      } finally {
        fixture.probe.resolve("1.25\n");
        fixture.release.resolve();
        await fixture.cleaned;
        await fixture.outcome;
      }

      const result = await fixture.outcome;
      expect(result.error).toBeUndefined();
      expect(fixture.post).toHaveBeenCalledOnce();
      const body = requireRecord(
        fixture.post.mock.calls[0]?.[1]?.body,
        "Discord voice message payload",
      );
      const attachments = body.attachments;
      if (!Array.isArray(attachments)) {
        throw new Error("Expected Discord voice attachments");
      }
      const attachment = requireRecord(attachments[0], "Discord voice attachment");
      expect(attachment.duration_secs).toBe(1.25);
      const waveform = typeof attachment.waveform === "string" ? attachment.waveform : "";
      expect(Buffer.from(waveform, "base64")).toHaveLength(256);
      if (!waveformFails) {
        expect(Buffer.from(waveform, "base64")).toEqual(
          Buffer.concat([Buffer.from([8, 8, 8]), Buffer.alloc(253)]),
        );
      }
      expect(await fs.readFile(fixture.inputPath)).toEqual(fixture.original);
      expect(await fs.readdir(media.root)).toEqual(["original.ogg"]);
    },
  );
});
