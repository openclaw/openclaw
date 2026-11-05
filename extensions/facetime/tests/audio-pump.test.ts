import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFaceTimeAudioPump } from "../src/audio-pump.js";

class FakeProcess extends EventEmitter {
  readonly pid = 1234;
  writes: Buffer[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(Buffer.from(chunk));
      callback();
    },
  });
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

const spawnMock = vi.hoisted(() =>
  vi.fn<(command: string, args: string[], options: SpawnOptions) => unknown>(),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

describe("FaceTime native audio bridge", () => {
  let activePump: ReturnType<typeof startFaceTimeAudioPump>;
  function expectProgress(...items: [string, number][]) {
    expect(activePump.getPlaybackState()).toEqual(
      items.map(([itemId, audioEndMs]) => ({ itemId, audioEndMs })),
    );
  }
  function createPump(overrides: Partial<Parameters<typeof startFaceTimeAudioPump>[0]> = {}) {
    const processes: FakeProcess[] = [];
    const spawn = spawnMock.mockImplementation(() => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    });
    const callbacks = { onInputAudio: vi.fn(), onPlaybackDrained: vi.fn() };
    activePump = startFaceTimeAudioPump({
      captureBinary: "/capture",
      logger: console,
      ...callbacks,
      ...overrides,
    });
    function processFor(command: string) {
      return processes[spawn.mock.calls.findIndex(([binary]) => binary.endsWith(command))];
    }
    return { pump: activePump, processes, spawn, processFor, ...callbacks };
  }
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await activePump.stop();
    vi.useRealTimers();
  });
  it("publishes suppression and route readiness from assembled native lines", async () => {
    const { pump, processes, spawn, onInputAudio } = createPump();

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
    const onError = vi.fn(async () => false);
    const { processes } = createPump({ onError });

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
    const { pump, processes, spawn, processFor, onPlaybackDrained } = createPump();

    const audio = Buffer.alloc(4_800, 4);
    pump.writeOutputAudio(audio, { itemId: "greeting" });
    const outputIndex = spawn.mock.calls.findIndex((call) => call[0].endsWith("sox"));
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(spawn.mock.calls[outputIndex]?.[1]).toContain("OpenClaw-Feed");
    expect(processFor("sox")?.writes).toEqual([audio]);
    expect(processes[0]?.writes).toEqual([]);
    pump.finishOutputAudio();
    expect(pump.playedAudioFrames()).toBe(0);
    expect(pump.queuedAudioFrames()).toBe(2_400);
    expectProgress(["greeting", 0]);
    await vi.advanceTimersByTimeAsync(199);
    expect(onPlaybackDrained).not.toHaveBeenCalled();
    expectProgress(["greeting", 99]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pump.playedAudioFrames()).toBe(2_400);
    expect(pump.queuedAudioFrames()).toBe(0);
    expect(onPlaybackDrained).toHaveBeenCalledExactlyOnceWith();
    expectProgress();
  });

  it("retains per-item progress across starvation until the response finishes", async () => {
    const { pump } = createPump();
    pump.writeOutputAudio(Buffer.alloc(9_600), { itemId: "prefix" });
    pump.writeOutputAudio(Buffer.alloc(38_400), { itemId: "answer" });
    await vi.advanceTimersByTimeAsync(600);
    expectProgress(["prefix", 200], ["answer", 300]);
    await vi.advanceTimersByTimeAsync(500);
    expect(pump.queuedAudioFrames()).toBe(0);
    expectProgress(["prefix", 200], ["answer", 800]);

    pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "answer" });
    await vi.advanceTimersByTimeAsync(150);
    expectProgress(["prefix", 200], ["answer", 850]);
    pump.finishOutputAudio();
    await vi.advanceTimersByTimeAsync(50);
    expectProgress();

    pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "next-answer" });
    await vi.advanceTimersByTimeAsync(200);
    expectProgress(["next-answer", 100]);
    pump.finishOutputAudio();
    expectProgress();
  });

  it.each(["barge-in", "suspend"] as const)(
    "clears %s playback without stale drain or failure callbacks",
    async (action) => {
      const onError = vi.fn(async () => false);
      const { pump, processes, spawn, onPlaybackDrained } = createPump({ onError });
      pump.writeOutputAudio(Buffer.alloc(4_800), { itemId: "interrupted" });
      if (action === "barge-in") {
        pump.finishOutputAudio();
        pump.clearOutputAudio();
      } else {
        await pump.suspendMedia();
      }
      const outputIndices = spawn.mock.calls.flatMap((call, index) =>
        call[0].endsWith("sox") ? [index] : [],
      );
      expect(processes[0]?.kills).toEqual([]);
      expect(outputIndices).toHaveLength(action === "barge-in" ? 2 : 1);
      expect(processes[outputIndices[0] ?? -1]?.kills).toEqual(["SIGKILL"]);
      await vi.advanceTimersByTimeAsync(200);
      expect(onPlaybackDrained).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(pump.queuedAudioFrames()).toBe(0);
      expectProgress();
    },
  );

  it("reports capture-process death as immediate suppression loss", () => {
    const onSuppressionLost = vi.fn();
    const { pump, processes } = createPump({
      onError: vi.fn(async () => false),
      onSuppressionLost,
    });
    processes[0]?.stderr.emit("data", "facetime-audio-capture: started FaceTime process tap\n");
    processes[0]?.emit("exit", 1, null);
    expect(pump.processOutputSuppressed()).toBe(false);
    expect(onSuppressionLost).toHaveBeenCalledOnce();
  });

  it("strips credential-shaped environment variables from native children", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "secret", SAFE_VALUE: "yes" }, async () => {
      const { pump, spawn, processFor } = createPump();

      for (const call of spawn.mock.calls) {
        expect(call[2].env).not.toHaveProperty("OPENAI_API_KEY");
        expect(call[2].env).toHaveProperty("SAFE_VALUE", "yes");
      }
      await pump.stop();
      expect(processFor("/capture")?.writes).toEqual([Buffer.from([4, 0, 0, 0, 4, 0, 0, 0, 0])]);
      expect(processFor("sox")?.kills).toEqual(["SIGKILL"]);
    });
  });
});
