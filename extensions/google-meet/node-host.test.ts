import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";

class MockChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ignoreSigterm = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_audio: Buffer, callback?: (error?: Error | null) => void) => {
      callback?.();
      return true;
    }),
  });
  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    if (signal !== "SIGTERM" || !this.ignoreSigterm) {
      queueMicrotask(() => finishMockChild(this, null, signal));
    }
    return true;
  });
}

function finishMockChild(child: MockChild, code: number | null, signal: NodeJS.Signals | null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
  // Capture EOF follows exit; otherwise a finite fake waits for the real drain deadline.
  child.stdout?.emit("end");
  child.stdout?.emit("close");
  child.emit("close", code, signal);
}

const children: MockChild[] = [];
let originalPlatform: NodeJS.Platform;

const MEET_URL = "https://meet.google.com/xyz-abcd-uvw";
const REALTIME_START = {
  action: "start",
  url: MEET_URL,
  mode: "realtime",
  launch: false,
  audioInputCommand: ["mock-rec"],
  audioOutputCommand: ["mock-play"],
};

async function invokeNodeHostJson(params: Record<string, unknown>) {
  return JSON.parse(await handleGoogleMeetNodeHostCommand(JSON.stringify(params)));
}

function bridgeCommand(action: string, bridgeId: string, params = {}) {
  return invokeNodeHostJson({ action, bridgeId, ...params });
}

function startBridge(params = {}) {
  return invokeNodeHostJson({ ...REALTIME_START, ...params });
}

const launchChrome = (params = {}) => startBridge({ mode: "transcribe", launch: true, ...params });

function commandPair(ignoreSigterm = false) {
  const [output, input] = children;
  assert(output && input, "expected node host command-pair processes");
  output.ignoreSigterm = input.ignoreSigterm = ignoreSigterm;
  return [output, input] as const;
}

function expectKills(processes: readonly MockChild[], ...signals: NodeJS.Signals[]) {
  for (const child of processes) {
    expect(child.kill.mock.calls).toEqual(signals.map((signal) => [signal]));
  }
}

async function expectStopWaits(stops: Array<() => Promise<unknown>>, pending?: () => void) {
  const settled = stops.map(() => false);
  const results = stops.map((stop, index) =>
    stop().finally(() => {
      settled[index] = true;
    }),
  );
  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toEqual(stops.map(() => false));
  pending?.();
  await vi.advanceTimersByTimeAsync(1);
  return Promise.all(results);
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: "BlackHole 2ch",
      stderr: "",
    })),
    spawn: vi.fn(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    }),
  };
});

describe("google-meet node host bridge sessions", () => {
  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    vi.mocked(spawnSync).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    vi.useRealTimers();
    children.length = 0;
  });

  afterAll(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("reports malformed params JSON with an owned error", async () => {
    await expect(handleGoogleMeetNodeHostCommand("{not json")).rejects.toThrow(
      "Google Meet node host received malformed params JSON.",
    );
  });

  it("rejects non-Meet start URLs before local Chrome side effects", async () => {
    await expect(
      startBridge({ url: "https://example.com/private-call", launch: true }),
    ).rejects.toThrow("url must be an explicit https://meet.google.com/... URL");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });

  it("starts observe-only Chrome without BlackHole or bridge processes", async () => {
    expect(await startBridge({ mode: "transcribe" })).toEqual({ launched: false });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });

  it("passes the Meet URL before Chrome profile args when launching a profiled browser", async () => {
    const start = await launchChrome({ browserProfile: "Profile 2" });
    expect(start.launched).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "open",
      ["-a", "Google Chrome", MEET_URL, "--args", "--profile-directory=Profile 2"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it.each([
    [false, "", "terminated by SIGTERM"],
    [true, "", "spawnSync open ETIMEDOUT"],
    [true, "child warning", "spawnSync open ETIMEDOUT: child warning"],
  ])(
    "preserves Chrome launch diagnostics (timeout=%s, stderr=%s)",
    async (timeout, stderr, diagnostic) => {
      vi.mocked(spawnSync).mockImplementationOnce(() => ({
        pid: 123,
        output: [null, "", stderr],
        stdout: "",
        stderr,
        status: null,
        signal: "SIGTERM",
        ...(timeout
          ? { error: Object.assign(new Error("spawnSync open ETIMEDOUT"), { code: "ETIMEDOUT" }) }
          : {}),
      }));
      await expect(launchChrome()).rejects.toThrow(
        `failed to launch Chrome for Meet: ${diagnostic}`,
      );
    },
  );

  it("clears output playback without closing the active bridge when the old output exits", async () => {
    const start = await startBridge();
    expect(children).toHaveLength(2);
    const firstOutput = children[0];
    const cleared = await bridgeCommand("clearAudio", start.bridgeId);
    expect(cleared).toEqual({ bridgeId: start.bridgeId, ok: true, clearCount: 1 });
    expect(children).toHaveLength(3);
    expect(firstOutput?.kill).toHaveBeenCalledWith("SIGTERM");
    firstOutput?.emit("error", new Error("stale output failed after clear"));
    firstOutput?.emit("exit", 0, "SIGTERM");
    expect((await bridgeCommand("status", start.bridgeId)).bridge).toMatchObject({
      bridgeId: start.bridgeId,
      closed: false,
      clearCount: 1,
      createdAt: expect.any(String),
    });
    const audio = Buffer.from([1, 2, 3]);
    await bridgeCommand("pushAudio", start.bridgeId, { base64: audio.toString("base64") });
    expect(children[2]?.stdin?.write).toHaveBeenCalledWith(audio, expect.any(Function));
    expect(firstOutput?.stdin?.write).not.toHaveBeenCalled();
    await expect(
      bridgeCommand("pushAudio", start.bridgeId, { base64: "not-base64!" }),
    ).rejects.toThrow("pushAudio base64 must be a valid audio payload");
    expect(children[2]?.stdin?.write).toHaveBeenCalledTimes(1);
    await bridgeCommand("stop", start.bridgeId);
  });

  it.each([false, true])(
    "waits for SIGTERM-resistant processes (retired output=%s)",
    async (retireOutput) => {
      vi.useFakeTimers();
      const start = await startBridge();
      const pair = commandPair(!retireOutput);
      const resistant = retireOutput ? [pair[0]] : pair;
      if (retireOutput) {
        pair[0].ignoreSigterm = true;
        await bridgeCommand("clearAudio", start.bridgeId);
      }
      await expectStopWaits([() => bridgeCommand("stop", start.bridgeId)], () =>
        expectKills(resistant, "SIGTERM"),
      );
      expect(resistant.map((child) => child.signalCode)).toEqual(resistant.map(() => "SIGKILL"));
      expectKills(resistant, "SIGTERM", "SIGKILL");
    },
  );

  it("closes once when command-pair streams fail together", async () => {
    const start = await startBridge();
    const [outputProcess, inputProcess] = commandPair();
    outputProcess.stderr?.emit("error", new Error("output stderr failed"));
    inputProcess.stdout?.emit("error", new Error("input stdout failed"));
    inputProcess.stderr?.emit("error", new Error("input stderr failed"));
    expect((await bridgeCommand("status", start.bridgeId)).bridge.closed).toBe(true);
    expectKills([outputProcess, inputProcess], "SIGTERM");
  });

  it("shares SIGTERM-resistant cleanup across concurrent stopByUrl calls", async () => {
    vi.useFakeTimers();
    await startBridge();
    const pair = commandPair(true);
    const stopParams = { action: "stopByUrl", url: MEET_URL, mode: "realtime" };
    const results = await expectStopWaits([
      () => invokeNodeHostJson(stopParams),
      () => invokeNodeHostJson(stopParams),
    ]);
    expect(results).toEqual([
      { ok: true, stopped: 1 },
      { ok: true, stopped: 0 },
    ]);
    expectKills(pair, "SIGTERM", "SIGKILL");
  });

  it("lists active bridge sessions and hides closed sessions", async () => {
    const url = "https://meet.google.com/abc-defg-hij";
    const listParams = { action: "list", url, mode: "realtime" };
    const start = await startBridge({ url: `${url}?authuser=1` });
    expect(typeof start.bridgeId).toBe("string");
    expect(start.bridgeId.length).toBeGreaterThan(0);
    expect(start).toEqual({
      audioBackend: "blackhole-2ch",
      audioBridge: { type: "node-command-pair", outputGeneration: true },
      audioDeviceLabel: "BlackHole 2ch",
      bridgeId: start.bridgeId,
      launched: false,
    });
    const activeList = await invokeNodeHostJson(listParams);
    expect(activeList.bridges).toMatchObject([
      {
        bridgeId: start.bridgeId,
        closed: false,
        mode: "realtime",
        url: `${url}?authuser=1`,
        createdAt: expect.any(String),
      },
    ]);
    if (children[1]) {
      finishMockChild(children[1], 0, null);
    }
    expect(await invokeNodeHostJson(listParams)).toEqual({ bridges: [] });
    expect(await invokeNodeHostJson({ ...listParams, action: "stopByUrl" })).toEqual({
      ok: true,
      stopped: 0,
    });
  });
});
