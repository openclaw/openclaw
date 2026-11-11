import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const workspace = vi.hoisted(() => ({
  rootDir: "",
  beforeCreate: undefined as (() => void) | undefined,
  afterWrite: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => workspace.rootDir,
    // The receive owner must observe leave before its awaited WAV write returns.
    tempWorkspace: async (options: Parameters<typeof actual.tempWorkspace>[0]) => {
      workspace.beforeCreate?.();
      const temporary = await actual.tempWorkspace(options);
      return {
        ...temporary,
        write: async (...args: Parameters<typeof temporary.write>) => {
          const filePath = await temporary.write(...args);
          await workspace.afterWrite?.();
          return filePath;
        },
      };
    },
  };
});

defineDiscordVoiceTests((h) => {
  beforeEach(async () => {
    workspace.beforeCreate = undefined;
    workspace.afterWrite = undefined;
    workspace.rootDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-wav-lifetime-")),
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(workspace.rootDir, { recursive: true, force: true });
  });

  async function fixture(recording = true) {
    const manager = h.createManager(
      h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:guest"] }),
      h.createClientWithMember("guest", "Guest", "1234"),
    );
    const sink = vi.fn();
    if (recording) {
      await h.startTranscripts(manager, sink, "notes");
    } else {
      await manager.join({ guildId: "g1", channelId: "1001" });
    }
    h.decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
      for await (const pcm of input) {
        await callbacks.onChunk(pcm, pcm);
      }
    });
    h.transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
      const wav = await fs.readFile(filePath);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      return { text: "Meeting notes" };
    });
    const entry = h.getSessionEntry(manager);
    const audio = await import("./audio.js");
    const writeWav = audio.writeVoiceWavFile;
    const cleanups: Promise<void>[] = [];
    vi.spyOn(audio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
      const wav = await writeWav(pcm);
      const released = createDeferred<void>();
      cleanups.push(released.promise);
      return { ...wav, cleanup: () => wav.cleanup().then(() => released.resolve()) };
    });
    const receive = async (pcm: Buffer | Buffer[] = Buffer.alloc(192_000)) => {
      const stream = new PassThrough({ objectMode: true });
      h.getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
      const receiving = h.handleSpeakingStart(manager, entry, "guest");
      for (const chunk of Array.isArray(pcm) ? pcm : [pcm]) {
        stream.write(chunk);
      }
      stream.end();
      await receiving;
    };
    const blocked = createDeferred<void>();
    const drain = async () => {
      await entry.processingQueue;
      await Promise.all(cleanups);
    };
    return {
      manager,
      entry,
      sink,
      receive,
      blocked,
      drain,
      async [Symbol.asyncDispose]() {
        workspace.beforeCreate = undefined;
        blocked.resolve();
        await drain();
        await manager.destroy();
      },
    };
  }

  it("snapshots split received PCM before creating the WAV workspace", async () => {
    await using f = await fixture(false);
    const pcm = Buffer.alloc(192_008, 0xa5);
    pcm.fill(Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xaa, 0x55, 0x12, 0x34]), 4, 192_004);
    const expectedPcm = Buffer.from(pcm.subarray(4, 192_004));
    let workspaceStarted = false;
    workspace.beforeCreate = () => {
      workspaceStarted = true;
      pcm.fill(0x66);
    };
    const receivedWavs: Buffer[] = [];
    h.transcribeAudioFileMock.mockImplementationOnce(async ({ filePath }) => {
      receivedWavs.push(await fs.readFile(filePath));
      return { text: "" };
    });
    await f.receive([pcm.subarray(4, 7), pcm.subarray(7, 192_004)]);
    await f.drain();
    expect(workspaceStarted).toBe(true);
    expect(receivedWavs.map((wav) => wav.toString("hex"))).toEqual([
      "5249464624ee020057415645666d7420100000000100020080bb000000ee0200040010006461746100ee0200" +
        expectedPcm.toString("hex"),
    ]);
    expect(await fs.readdir(workspace.rootDir)).toEqual([]);
  });

  it.each(["queued", "transcribing"] as const)(
    "retains %s WAV input beyond thirty minutes and releases it after transcription",
    async (phase) => {
      await using f = await fixture();
      const transcribing = createDeferred<void>();
      if (phase === "queued") {
        f.entry.processingQueue = f.blocked.promise;
      } else {
        h.transcribeAudioFileMock.mockImplementationOnce(async ({ filePath }) => {
          transcribing.resolve();
          await f.blocked.promise;
          const wav = await fs.readFile(filePath);
          expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
          return { text: "Meeting notes" };
        });
      }
      const removals = vi.spyOn(fs, "rm");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await f.receive();
      if (phase === "transcribing") {
        await transcribing.promise;
      }
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
      await Promise.all(removals.mock.results.map((result) => result.value));
      expect(await fs.readdir(workspace.rootDir)).toHaveLength(1);
      f.blocked.resolve();
      await f.drain();
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Meeting notes" }),
      );
      expect(await fs.readdir(workspace.rootDir)).toEqual([]);
    },
  );

  it.each([
    "transcription failure",
    "rejected queue",
    "left channel",
    "replaced capture",
    "short audio",
    "left during write",
  ] as const)("releases WAV input after %s without waiting for a timer", async (reason) => {
    await using f = await fixture(
      reason === "transcription failure" ||
        reason === "rejected queue" ||
        reason === "replaced capture",
    );
    f.entry.processingQueue = f.blocked.promise;
    if (reason === "transcription failure") {
      h.transcribeAudioFileMock.mockRejectedValueOnce(new Error("STT unavailable"));
    } else if (reason === "left during write") {
      workspace.afterWrite = async () => {
        await f.manager.leave({ guildId: "g1" });
      };
    }
    await f.receive(reason === "short audio" ? Buffer.alloc(960) : undefined);
    if (reason === "left channel") {
      await f.manager.leave({ guildId: "g1" });
    } else if (reason === "replaced capture") {
      await h.startTranscripts(f.manager, vi.fn(), "replacement");
    }
    if (reason === "left during write") {
      expect(f.manager.status()).toEqual([]);
      expect(await fs.readdir(workspace.rootDir)).toEqual([]);
    }
    if (reason === "rejected queue") {
      f.blocked.reject(new Error("Previous processing failed"));
    } else {
      f.blocked.resolve();
    }
    await f.drain();
    expect(f.sink).not.toHaveBeenCalled();
    if (reason === "transcription failure") {
      expect(h.loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("STT unavailable"));
    } else {
      expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
    }
    expect(await fs.readdir(workspace.rootDir)).toEqual([]);
  });
});
