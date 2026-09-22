import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
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

import { getVoiceMessageMetadata } from "./voice-message.js";

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
  media.probe.mockReturnValue(probe.promise);
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
    const pcm = Buffer.alloc(512);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(1_000, offset);
    }
    await fs.writeFile(outputPath, pcm);
    return "";
  });
  let settled = false;
  const outcome = getVoiceMessageMetadata(inputPath).then(
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
    probe,
    started: started.promise,
    release,
    cleaned: cleaned.promise,
    outcome,
    isSettled: () => settled,
  };
}

describe("voice metadata settlement owns waveform cleanup", () => {
  it.each(["failure", "cancellation"] as const)(
    "joins waveform cleanup before reporting duration %s",
    async (failure) => {
      const fixture = await arrangeMetadata();
      const probeError = Object.assign(new Error(`duration ${failure}`), {
        signal: failure === "cancellation" ? "SIGTERM" : undefined,
      });
      let settledBeforeWaveformRelease = false;
      try {
        await vi.waitFor(() => expect(media.waveform).toHaveBeenCalledOnce());
        await fixture.started;
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
        message: `Failed to get audio duration: duration ${failure}`,
        cause: probeError,
      });
      expect(await fs.readFile(fixture.inputPath)).toEqual(fixture.original);
      expect(await fs.readdir(media.root)).toEqual(["original.ogg"]);
      expect(settledBeforeWaveformRelease).toBe(false);
    },
  );

  it.each([false, true])(
    "returns usable metadata after waveform failure=%s and cleanup",
    async (waveformFails) => {
      const fixture = await arrangeMetadata(waveformFails);
      try {
        await vi.waitFor(() => expect(media.waveform).toHaveBeenCalledOnce());
        await fixture.started;
        fixture.probe.resolve("1.25\n");
      } finally {
        fixture.probe.resolve("1.25\n");
        fixture.release.resolve();
        await fixture.cleaned;
        await fixture.outcome;
      }

      const result = await fixture.outcome;
      expect(result.error).toBeUndefined();
      expect(result.value?.durationSecs).toBe(1.25);
      expect(Buffer.from(result.value?.waveform ?? "", "base64")).toHaveLength(256);
      expect(await fs.readFile(fixture.inputPath)).toEqual(fixture.original);
      expect(await fs.readdir(media.root)).toEqual(["original.ogg"]);
    },
  );
});
