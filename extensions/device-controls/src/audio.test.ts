import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AudioExecutor, parseAudio } from "./audio.js";

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: processMock.spawn }));

const operationId = "00000000-0000-4000-8000-000000000001";
const notes = [{ frequencyHz: 261.63, durationMs: 100 }];
const play = { operation: "play", operationId, notes };

describe("bounded device audio", () => {
  it("renders actual bounded mono PCM with silence at note boundaries", async () => {
    const sink = vi.fn(async (_wav: Buffer) => {});
    await new AudioExecutor(sink).execute(play);
    const wav = sink.mock.calls[0]![0];
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.length).toBe(44 + (2 * 24_000) / 10);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(wav.length - 2)).toBe(0);
    const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, index) =>
      Math.abs(wav.readInt16LE(44 + index * 2)),
    );
    expect(Math.max(...samples)).toBeGreaterThan(3_000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(3_277);
  });

  it("rejects malformed, excessive, and executable input before touching the sink", async () => {
    const sink = vi.fn();
    const executor = new AudioExecutor(sink);
    const invalid = [
      { ...play, command: "anything" },
      { ...play, operationId: "not-a-uuid" },
      { ...play, notes: [{ frequencyHz: Number.NaN, durationMs: 100 }] },
      { ...play, notes: [{ frequencyHz: 440, durationMs: 0 }] },
      {
        ...play,
        notes: Array.from({ length: 6 }, () => ({ frequencyHz: 440, durationMs: 2_000 })),
      },
      { ...play, notes: Array.from({ length: 33 }, () => notes[0]) },
      { ...play, volume: 1 },
      { ...play, operation: "stop" },
    ];
    for (const request of invalid) {
      await expect(executor.execute(request)).rejects.toThrow();
    }
    expect(sink).not.toHaveBeenCalled();
    expect(executor.busy).toBe(false);
    expect(parseAudio(play)).toMatchObject({ volume: 0.1 });
  });

  it("does not queue playback and stops only the authorized operation, awaiting cleanup", async () => {
    let stopped!: () => void;
    const executor = new AudioExecutor(
      (_wav, signal) =>
        new Promise((_resolve, reject) => {
          stopped = () => reject(signal.reason as Error);
          signal.addEventListener("abort", stopped, { once: true });
        }),
    );
    const first = executor.execute(play);
    const firstStopped = expect(first).resolves.toEqual({ status: "stopped" });
    await Promise.resolve();
    expect(executor.busy).toBe(true);
    await expect(executor.execute(play)).rejects.toThrow("busy");
    await expect(
      executor.execute({ operation: "stop", operationId: "00000000-0000-4000-8000-000000000002" }),
    ).rejects.toThrow("does not own");
    expect(executor.busy).toBe(true);
    await expect(executor.execute({ operation: "stop", operationId })).resolves.toEqual({
      status: "stopped",
    });
    await firstStopped;
    expect(executor.busy).toBe(false);
    await expect(executor.execute({ operation: "stop", operationId })).resolves.toEqual({
      status: "stopped",
    });
  });

  it("cancels on caller abort and node disconnect without retaining active work", async () => {
    for (const cause of ["caller", "disconnect"] as const) {
      const caller = new AbortController();
      const executor = new AudioExecutor(
        (_wav, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          }),
      );
      const result = executor.execute(play, caller.signal);
      const rejected = expect(result).rejects.toThrow();
      await Promise.resolve();
      if (cause === "caller") {
        caller.abort(new Error("Caller left"));
      } else {
        await executor.disconnect();
      }
      await rejected;
      expect(executor.busy).toBe(false);
    }
  });

  it("installs the fixed deadline and releases the executor after expiry", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const sink = vi.fn(
      (_wav: Buffer, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        }),
    );
    const executor = new AudioExecutor(sink);
    try {
      const result = executor.execute(play);
      const rejected = expect(result).rejects.toThrow("Deadline");
      await Promise.resolve();
      expect(timeout).toHaveBeenCalledExactlyOnceWith(12_000);
      deadline.abort(new Error("Deadline"));
      await rejected;
      expect(executor.busy).toBe(false);
      const aborted = new AbortController();
      aborted.abort(new Error("Already cancelled"));
      await expect(executor.execute(play, aborted.signal)).rejects.toThrow("Already cancelled");
      expect(sink).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("reports cleanup failures instead of acknowledging a successful stop", async () => {
    const executor = new AudioExecutor(
      (_wav, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Owned file cleanup failed")), {
            once: true,
          });
        }),
    );
    const playing = executor.execute(play);
    const rejected = expect(playing).rejects.toThrow("Owned file cleanup failed");
    await Promise.resolve();
    await expect(executor.execute({ operation: "stop", operationId })).rejects.toThrow(
      "Owned file cleanup failed",
    );
    await rejected;
  });

  it("spawns only afplay with the owned WAV and removes it after native exit", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    processMock.spawn.mockReturnValueOnce(child);
    processMock.spawn.mockClear();
    const result = new AudioExecutor().execute(play);
    await vi.waitFor(() => expect(processMock.spawn).toHaveBeenCalled());
    const [binary, args, options] = processMock.spawn.mock.calls.at(-1)!;
    expect(binary).toBe("/usr/bin/afplay");
    expect(args).toHaveLength(1);
    expect(options).toMatchObject({
      shell: false,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    const wav = await readFile(args[0]);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(44 + 4_800);
    child.emit("close", 0);
    await result;
    await expect(access(args[0])).rejects.toThrow();
  });

  it("terminates its native child on cancellation before disposing the owned file", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    processMock.spawn.mockClear().mockReturnValueOnce(child);
    const caller = new AbortController();
    const result = new AudioExecutor().execute(play, caller.signal);
    const rejected = expect(result).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(processMock.spawn).toHaveBeenCalledOnce());
    const filename = processMock.spawn.mock.calls[0]![1][0];
    caller.abort(new Error("Cancelled"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(access(filename)).resolves.toBeUndefined();
    child.emit("close", null);
    await rejected;
    await expect(access(filename)).rejects.toThrow();
  });
});
