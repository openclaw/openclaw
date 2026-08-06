import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildSoxOutputArguments,
  MAX_PLAYBACK_BUFFERED_BYTES,
  FACETIME_FEED_DEVICE_NAME,
  sanitizedAudioChildEnv,
  startFaceTimeAudioPump,
} from "../src/audio-pump.js";

class FakePipe extends EventEmitter {
  writes: Buffer[] = [];
  ended = false;
  writableLength = 0;

  write(chunk: Buffer) {
    this.writes.push(chunk);
    this.writableLength += chunk.byteLength;
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeProcess extends EventEmitter {
  readonly pid = 1234;
  readonly stdin = new FakePipe();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  killed = false;

  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }
}

describe("FaceTime audio pump", () => {
  it("captures caller audio with the process tap and reports hardware suppression ready", async () => {
    const processes: FakeProcess[] = [];
    const spawn = vi.fn((_command, _args, _options) => {
      const proc = new FakeProcess();
      processes.push(proc);
      return proc;
    });
    const onInputAudio = vi.fn();

    const pump = startFaceTimeAudioPump({
      captureBinary: "/plugin/native/.build/release/facetime-audio-capture",
      logger: console,
      onInputAudio,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0]?.[1]).toEqual(buildSoxOutputArguments());
    expect(spawn.mock.calls[0]?.[1]).toContain(FACETIME_FEED_DEVICE_NAME);
    expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "ignore", "pipe"]);
    expect(spawn.mock.calls[1]?.slice(0, 2)).toEqual([
      "/plugin/native/.build/release/facetime-audio-capture",
      [],
    ]);
    expect(spawn.mock.calls[1]?.[2]?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spawn.mock.calls[2]?.slice(0, 2)).toEqual([
      "/usr/bin/caffeinate",
      ["-d", "-i", "-w", "1234"],
    ]);

    const suppressionReady = pump.suppressionReady();
    expect(pump.processOutputSuppressed()).toBe(false);
    processes[1]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
    await expect(suppressionReady).resolves.toBeUndefined();
    expect(pump.processOutputSuppressed()).toBe(true);
    const routeReady = pump.routeReady();
    processes[1]?.stderr.emit(
      "data",
      "facetime-audio-capture: verified OpenClaw-Mic input route\n",
    );
    await expect(routeReady).resolves.toBeUndefined();

    processes[1]?.stdout.emit("data", Buffer.from([1, 2, 3]));
    processes[1]?.stdout.emit("data", Buffer.alloc(0));
    expect(onInputAudio).toHaveBeenCalledOnce();
    expect(onInputAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it("starts the microphone-route deadline only when post-answer readiness begins", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        onError: vi.fn(async () => false),
        spawn: vi.fn(() => {
          const process = new FakeProcess();
          processes.push(process);
          return process;
        }),
      });

      await vi.advanceTimersByTimeAsync(9_000);
      processes[1]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
      await pump.suppressionReady();

      const routeReady = pump.routeReady();
      await vi.advanceTimersByTimeAsync(14_999);
      processes[1]?.stderr.emit(
        "data",
        "facetime-audio-capture: verified OpenClaw-Mic input route\n",
      );
      await expect(routeReady).resolves.toBeUndefined();

      const stopped = pump.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes output, clears queued playback, and stops every child", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const spawn = vi.fn((_command, _args, _options) => {
        const proc = new FakeProcess();
        processes.push(proc);
        return proc;
      });
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        onError: vi.fn(),
        spawn,
      });

      const firstOutput = processes[0];
      pump.writeOutputAudio(Buffer.from([4, 5, 6]));
      expect(firstOutput?.stdin.writes).toEqual([Buffer.from([4, 5, 6])]);

      pump.clearOutputAudio();
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(firstOutput?.kills).toEqual(["SIGKILL"]);
      firstOutput?.stdin.emit("error", new Error("EPIPE from cleared output"));

      const capture = processes[1];
      const wake = processes[2];
      const secondOutput = processes[3];
      expect(secondOutput?.kills).toEqual([]);
      const stopPromise = pump.stop();
      await vi.advanceTimersByTimeAsync(2000);
      await stopPromise;
      expect(wake?.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(capture?.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(secondOutput?.kills).toEqual(["SIGKILL"]);
      expect(capture?.stdin.ended).toBe(true);
      expect(secondOutput?.stdin.ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports playback drain only after scheduled audio should be audible", async () => {
    vi.useFakeTimers();
    try {
      const onPlaybackDrained = vi.fn();
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        onPlaybackDrained,
        spawn: vi.fn(() => new FakeProcess()),
      });

      pump.writeOutputAudio(Buffer.alloc(4_800));
      expect(pump.generatedAudioMs()).toBe(100);
      expect(pump.queuedAudioMs()).toBe(100);
      await vi.advanceTimersByTimeAsync(199);
      expect(onPlaybackDrained).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(onPlaybackDrained).toHaveBeenCalledOnce();
      expect(pump.queuedAudioMs()).toBe(0);
      const stopPromise = pump.stop();
      await vi.advanceTimersByTimeAsync(2000);
      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled playback process", () => {
    const processes: FakeProcess[] = [];
    const spawn = vi.fn(() => {
      const proc = new FakeProcess();
      processes.push(proc);
      return proc;
    });
    const onError = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError,
      spawn,
    });
    if (processes[0]) {
      processes[0].stdin.writableLength = MAX_PLAYBACK_BUFFERED_BYTES;
    }

    pump.writeOutputAudio(Buffer.from([1]));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("2 MiB") }),
    );
    expect(processes[0]?.stdin.writes).toEqual([]);
  });

  it("retains process suppression when failure cleanup is not yet safe", async () => {
    const processes: FakeProcess[] = [];
    const onError = vi.fn(async () => false);
    startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError,
      spawn: vi.fn(() => {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      }),
    });

    processes[1]?.emit("error", new Error("helper unavailable"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(processes.every((process) => process.kills.length === 0)).toBe(true);
  });

  it("stops model input and playback while retaining the native safety tap", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const onInputAudio = vi.fn();
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio,
        spawn: vi.fn(() => {
          const process = new FakeProcess();
          processes.push(process);
          return process;
        }),
      });
      processes[1]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
      pump.writeOutputAudio(Buffer.from([1, 2]));

      const suspended = pump.suspendMedia();
      await vi.advanceTimersByTimeAsync(1_000);
      await suspended;
      processes[1]?.stdout.emit("data", Buffer.from([3, 4]));
      pump.writeOutputAudio(Buffer.from([5, 6]));
      pump.clearOutputAudio();

      expect(pump.processOutputSuppressed()).toBe(true);
      expect(processes[0]?.kills).toEqual(["SIGKILL"]);
      expect(processes[1]?.kills).toEqual([]);
      expect(processes[2]?.kills).toEqual([]);
      expect(onInputAudio).not.toHaveBeenCalled();
      expect(processes).toHaveLength(3);

      const stopped = pump.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await stopped;
      expect(processes[1]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(processes[2]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose credentials to native audio children", () => {
    expect(
      sanitizedAudioChildEnv({
        HOME: "/tmp/home",
        OPENAI_API_KEY: "secret",
        SOME_AUTH_TOKEN: "secret",
        PATH: "/bin",
      }),
    ).toEqual({ HOME: "/tmp/home", PATH: "/bin" });
  });
});
