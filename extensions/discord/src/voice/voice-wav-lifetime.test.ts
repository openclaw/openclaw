import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

type WorkspaceDisposal = {
  settled: Promise<void>;
  calls: number;
  method: "none" | "async-dispose" | "cleanup";
  outcome: "pending" | "fulfilled" | "rejected";
  errorCategory: "none" | "filesystem" | "fs-safe" | "other";
};

const workspace = vi.hoisted(() => ({
  rootDir: "",
  beforeCreate: undefined as (() => void) | undefined,
  afterWrite: undefined as (() => Promise<void>) | undefined,
  disposals: [] as WorkspaceDisposal[],
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
      const settled = createDeferred<void>();
      const disposal: WorkspaceDisposal = {
        settled: settled.promise,
        calls: 0,
        method: "none",
        outcome: "pending",
        errorCategory: "none",
      };
      // Register before handing the workspace to audio; a late export spy can miss
      // the real cleanup while the conversation queue intentionally settles first.
      workspace.disposals.push(disposal);
      const observeDisposal = async <T>(
        method: WorkspaceDisposal["method"],
        run: () => Promise<T>,
      ): Promise<T> => {
        disposal.calls += 1;
        disposal.method = method;
        try {
          const result = await run();
          disposal.outcome = "fulfilled";
          return result;
        } catch (error) {
          disposal.outcome = "rejected";
          const code = error instanceof Error && "code" in error ? error.code : undefined;
          disposal.errorCategory =
            code === "EACCES" || code === "EPERM" || code === "ENOSPC" || code === "EIO"
              ? "filesystem"
              : error instanceof Error && error.name === "FsSafeError"
                ? "fs-safe"
                : "other";
          throw error;
        } finally {
          settled.resolve();
        }
      };
      return {
        ...temporary,
        cleanup: () => observeDisposal("cleanup", () => temporary.cleanup()),
        [Symbol.asyncDispose]: () =>
          observeDisposal("async-dispose", () => temporary[Symbol.asyncDispose]()),
        write: async (...args: Parameters<typeof temporary.write>) => {
          const filePath = await temporary.write(...args);
          await workspace.afterWrite?.();
          return filePath;
        },
      };
    },
  };
});

defineDiscordVoiceTests(
  ({
    expect,
    it,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    getSessionConnection,
    handleSpeakingStart,
    startTranscripts,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    loggerWarnMock,
  }) => {
    beforeEach(async () => {
      workspace.beforeCreate = undefined;
      workspace.afterWrite = undefined;
      workspace.disposals = [];
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
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:guest"] }),
        createClientWithMember("guest", "Guest", "1234"),
      );
      const sink = vi.fn();
      if (recording) {
        await startTranscripts(manager, sink, "notes");
      } else {
        await manager.join({ guildId: "g1", channelId: "1001" });
      }
      decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
        for await (const pcm of input) {
          await callbacks.onChunk(pcm, pcm);
        }
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
        return { text: "Meeting notes" };
      });
      const entry = getSessionEntry(manager);
      const receive = async (pcm: Buffer | Buffer[] = Buffer.alloc(192_000)) => {
        const stream = new PassThrough({ objectMode: true });
        getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = handleSpeakingStart(manager, entry, "guest");
        for (const chunk of Array.isArray(pcm) ? pcm : [pcm]) {
          stream.write(chunk);
        }
        stream.end();
        await receiving;
      };
      return {
        manager,
        entry,
        sink,
        receive,
        released: () => Promise.all(workspace.disposals.map(({ settled }) => settled)),
      };
    }

    function expectReleased(expected = 1) {
      // asyncDispose returns no cleanup result; only the directory assertion below
      // proves removal. Keep failed-observation details bounded and path-free.
      expect({
        created: workspace.disposals.length,
        disposals: workspace.disposals
          .slice(0, 4)
          .map(({ calls, method, outcome, errorCategory }) => ({
            calls,
            method,
            outcome,
            errorCategory,
          })),
      }).toEqual({
        created: expected,
        disposals: Array.from({ length: expected }, () => ({
          calls: 1,
          method: "async-dispose",
          outcome: "fulfilled",
          errorCategory: "none",
        })),
      });
    }

    it("snapshots split received PCM before creating the WAV workspace", async () => {
      const f = await fixture(false);
      const pcm = Buffer.alloc(192_008, 0xa5);
      pcm.fill(Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xaa, 0x55, 0x12, 0x34]), 4, 192_004);
      const expectedPcm = Buffer.from(pcm.subarray(4, 192_004));
      let workspaceStarted = false;
      workspace.beforeCreate = () => {
        workspaceStarted = true;
        pcm.fill(0x66);
      };
      const receivedWavs: Buffer[] = [];
      transcribeAudioFileMock.mockImplementationOnce(async ({ filePath }) => {
        receivedWavs.push(await fs.readFile(filePath));
        return { text: "" };
      });
      try {
        await f.receive([pcm.subarray(4, 7), pcm.subarray(7, 192_004)]);
        await f.entry.processingQueue;
        await f.released();
        expect(workspaceStarted).toBe(true);
        expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
        expect(receivedWavs).toHaveLength(1);
        const wav = receivedWavs[0];
        expect(wav?.subarray(0, 44).toString("hex")).toBe(
          "5249464624ee020057415645666d7420100000000100020080bb000000ee020004001000" +
            "6461746100ee0200",
        );
        expect(wav?.subarray(44)).toEqual(expectedPcm);
        expect(await fs.readdir(workspace.rootDir)).toEqual([]);
      } finally {
        workspace.beforeCreate = undefined;
        await f.entry.processingQueue;
        await f.released();
        await f.manager.destroy();
      }
    });

    it.each(["queued", "transcribing"] as const)(
      "retains %s WAV input beyond thirty minutes and releases it after transcription",
      async (phase) => {
        const f = await fixture();
        const blocked = createDeferred<void>();
        const transcribing = createDeferred<void>();
        if (phase === "queued") {
          f.entry.processingQueue = blocked.promise;
        } else {
          transcribeAudioFileMock.mockImplementationOnce(async ({ filePath }) => {
            transcribing.resolve();
            await blocked.promise;
            const wav = await fs.readFile(filePath);
            expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
            return { text: "Meeting notes" };
          });
        }
        const removals = vi.spyOn(fs, "rm");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await f.receive();
          if (phase === "transcribing") {
            await transcribing.promise;
          }
          await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
          await Promise.all(removals.mock.results.map((result) => result.value));
          expect(await fs.readdir(workspace.rootDir)).toHaveLength(1);
          blocked.resolve();
          await f.entry.processingQueue;
          await f.released();
          expectReleased();
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: "Meeting notes" }),
          );
          expect(await fs.readdir(workspace.rootDir)).toEqual([]);
        } finally {
          blocked.resolve();
          await f.entry.processingQueue;
          await f.released();
          await f.manager.destroy();
        }
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
      const f = await fixture(
        reason === "transcription failure" ||
          reason === "rejected queue" ||
          reason === "replaced capture",
      );
      const blocked = createDeferred<void>();
      f.entry.processingQueue = blocked.promise;
      if (reason === "transcription failure") {
        transcribeAudioFileMock.mockRejectedValueOnce(new Error("STT unavailable"));
      } else if (reason === "left during write") {
        workspace.afterWrite = async () => {
          await f.manager.leave({ guildId: "g1" });
        };
      }
      try {
        await f.receive(reason === "short audio" ? Buffer.alloc(960) : undefined);
        if (reason === "left channel") {
          await f.manager.leave({ guildId: "g1" });
        } else if (reason === "replaced capture") {
          await startTranscripts(f.manager, vi.fn(), "replacement");
        }
        if (reason === "left during write") {
          expect(f.manager.status()).toEqual([]);
          expect(await fs.readdir(workspace.rootDir)).toEqual([]);
        }
        if (reason === "rejected queue") {
          blocked.reject(new Error("Previous processing failed"));
        } else {
          blocked.resolve();
        }
        await f.entry.processingQueue;
        await f.released();
        expectReleased(reason === "short audio" ? 0 : 1);
        expect(f.sink).not.toHaveBeenCalled();
        if (reason === "transcription failure") {
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("STT unavailable"));
        } else {
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        }
        expect(await fs.readdir(workspace.rootDir)).toEqual([]);
      } finally {
        blocked.resolve();
        await f.entry.processingQueue;
        await f.released();
        await f.manager.destroy();
      }
    });
  },
);
