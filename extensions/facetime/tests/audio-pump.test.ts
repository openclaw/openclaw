import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { startFaceTimeAudioPump } from "../src/audio-pump.js";

class FakePipe extends Writable {
  writes: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.writes.push(Buffer.from(chunk));
    callback();
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
    this.emit("exit", null, signal);
    return true;
  }
}

type TestSpawn = NonNullable<Parameters<typeof startFaceTimeAudioPump>[0]["spawn"]>;

function captureProcesses(processes: FakeProcess[]) {
  return vi.fn<TestSpawn>((_command, _args, _options) => {
    const process = new FakeProcess();
    processes.push(process);
    return process;
  });
}

describe("FaceTime native audio bridge", () => {
  it("routes model audio through the separate SoX playback process", () => {
    const processes: FakeProcess[] = [];
    const spawn = captureProcesses(processes);
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      spawn,
    });

    const outputIndex = spawn.mock.calls.findIndex((call) => call[0].endsWith("sox"));
    const captureIndex = spawn.mock.calls.findIndex((call) => call[0] === "/capture");
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(spawn.mock.calls[outputIndex]?.[1]).toContain("OpenClaw-Feed");
    pump.writeOutputAudio(Buffer.from([4, 5, 6]));
    expect(processes[outputIndex]?.stdin.writes).toEqual([Buffer.from([4, 5, 6])]);
    expect(processes[captureIndex]?.stdin.writes).toEqual([]);
  });

  it("publishes suppression and route readiness from assembled native lines", async () => {
    const processes: FakeProcess[] = [];
    const spawn = captureProcesses(processes);
    const onInputAudio = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio,
      spawn,
    });

    expect(spawn.mock.calls[0]?.[0]).toBe("/capture");
    expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(pump.processOutputSuppressed()).toBe(false);
    processes[0]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process");
    expect(pump.processOutputSuppressed()).toBe(false);
    processes[0]?.stderr.emit("data", " tap\n");
    await pump.suppressionReady();
    expect(pump.processOutputSuppressed()).toBe(true);
    const route = pump.routeReady();
    processes[0]?.stderr.emit("data", "facetime-audio-capture: verified OpenClaw-Mic input");
    processes[0]?.stderr.emit("data", " route\n");
    await route;
    processes[0]?.stdout.emit("data", Buffer.from([1, 2]));
    expect(onInputAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
  });

  it("assembles fatal markers split across stderr chunks", () => {
    const processes: FakeProcess[] = [];
    const onError = vi.fn(async () => false);
    startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError,
      spawn: captureProcesses(processes),
    });

    processes[0]?.stderr.emit("data", "facetime-audio-capture: fatal-safety");
    expect(onError).not.toHaveBeenCalled();
    processes[0]?.stderr.emit("data", "-retained: process tap failed\n");

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "native FaceTime safety monitor reported a fatal error: process tap failed",
      }),
    );
  });

  it("reports playback drain after the separate output process should be audible", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const onPlaybackDrained = vi.fn();
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        onPlaybackDrained,
        spawn: captureProcesses(processes),
      });

      pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "greeting" });
      pump.finishOutputAudio();
      expect(pump.playedAudioFrames()).toBe(0);
      expect(pump.queuedAudioFrames()).toBe(2_400);
      expect(pump.getPlaybackState()).toEqual([{ itemId: "greeting", audioEndMs: 0 }]);
      await vi.advanceTimersByTimeAsync(199);
      expect(onPlaybackDrained).not.toHaveBeenCalled();
      expect(pump.getPlaybackState()).toEqual([{ itemId: "greeting", audioEndMs: 99 }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(pump.playedAudioFrames()).toBe(2_400);
      expect(pump.queuedAudioFrames()).toBe(0);
      expect(onPlaybackDrained).toHaveBeenCalledWith({
        generation: 1,
        playedFrames: 2_400,
      });
      expect(pump.getPlaybackState()).toEqual([]);
      await pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains per-item progress across starvation until the response finishes", async () => {
    vi.useFakeTimers();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      spawn: captureProcesses([]),
    });
    try {
      pump.writeOutputAudio(Buffer.alloc(9_600), { itemId: "prefix" });
      pump.writeOutputAudio(Buffer.alloc(38_400), { itemId: "answer" });
      await vi.advanceTimersByTimeAsync(600);
      expect(pump.getPlaybackState()).toEqual([
        { itemId: "prefix", audioEndMs: 200 },
        { itemId: "answer", audioEndMs: 300 },
      ]);
      await vi.advanceTimersByTimeAsync(500);
      expect(pump.queuedAudioFrames()).toBe(0);
      expect(pump.getPlaybackState()).toEqual([
        { itemId: "prefix", audioEndMs: 200 },
        { itemId: "answer", audioEndMs: 800 },
      ]);

      pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "answer" });
      await vi.advanceTimersByTimeAsync(150);
      expect(pump.getPlaybackState()).toEqual([
        { itemId: "prefix", audioEndMs: 200 },
        { itemId: "answer", audioEndMs: 850 },
      ]);
      pump.finishOutputAudio();
      await vi.advanceTimersByTimeAsync(50);
      expect(pump.getPlaybackState()).toEqual([]);

      pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "next-answer" });
      await vi.advanceTimersByTimeAsync(200);
      expect(pump.getPlaybackState()).toEqual([{ itemId: "next-answer", audioEndMs: 100 }]);
      pump.finishOutputAudio();
      expect(pump.getPlaybackState()).toEqual([]);
    } finally {
      await pump.stop();
      vi.useRealTimers();
    }
  });

  it("invalidates stale drain callbacks when barge-in clears playback", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const spawn = captureProcesses(processes);
      const onPlaybackDrained = vi.fn();
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        onPlaybackDrained,
        spawn,
      });
      pump.writeOutputAudio(Buffer.alloc(480), { itemId: "interrupted" });
      pump.finishOutputAudio();
      pump.clearOutputAudio();
      const captureIndex = spawn.mock.calls.findIndex((call) => call[0] === "/capture");
      const outputIndices = spawn.mock.calls.flatMap((call, index) =>
        call[0].endsWith("sox") ? [index] : [],
      );
      expect(processes[captureIndex]?.kills).toEqual([]);
      expect(outputIndices).toHaveLength(2);
      expect(processes[outputIndices[0] ?? -1]?.kills).toEqual(["SIGKILL"]);
      await vi.advanceTimersByTimeAsync(200);
      expect(onPlaybackDrained).not.toHaveBeenCalled();
      expect(pump.queuedAudioFrames()).toBe(0);
      expect(pump.getPlaybackState()).toEqual([]);
      await pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports capture-process death as immediate suppression loss", () => {
    const processes: FakeProcess[] = [];
    const onSuppressionLost = vi.fn();
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError: vi.fn(async () => false),
      onSuppressionLost,
      spawn: captureProcesses(processes),
    });
    processes[0]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
    processes[0]?.emit("exit", 1, null);
    expect(pump.processOutputSuppressed()).toBe(false);
    expect(onSuppressionLost).toHaveBeenCalledOnce();
  });

  it("does not report intentional media suspension as a playback failure", async () => {
    const processes: FakeProcess[] = [];
    const onError = vi.fn(async () => false);
    const pump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      onInputAudio() {},
      onError,
      spawn: captureProcesses(processes),
    });

    pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "suspended" });
    await pump.suspendMedia();

    expect(processes[1]?.kills).toEqual(["SIGKILL"]);
    expect(onError).not.toHaveBeenCalled();
    expect(processes[0]?.kills).toEqual([]);
    expect(pump.getPlaybackState()).toEqual([]);
    await pump.stop();
  });

  it("strips credential-shaped environment variables from native children", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "secret", SAFE_VALUE: "yes" }, async () => {
      const processes: FakeProcess[] = [];
      const spawn = captureProcesses(processes);
      const pump = startFaceTimeAudioPump({
        captureBinary: "/capture",
        logger: console,
        onInputAudio() {},
        spawn,
      });

      for (const call of spawn.mock.calls) {
        expect(call[2].env).not.toHaveProperty("OPENAI_API_KEY");
        expect(call[2].env).toHaveProperty("SAFE_VALUE", "yes");
      }
      await pump.stop();
      const captureIndex = spawn.mock.calls.findIndex((call) => call[0] === "/capture");
      const outputIndex = spawn.mock.calls.findIndex((call) => call[0].endsWith("sox"));
      expect(processes[captureIndex]?.stdin.writes).toEqual([
        Buffer.from([4, 0, 0, 0, 4, 0, 0, 0, 0]),
      ]);
      expect(processes[outputIndex]?.kills).toEqual(["SIGKILL"]);
    });
  });
});
