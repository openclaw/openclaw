import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFaceTimeVideoCapture } from "../src/video-capture.js";

class FakeHelper extends EventEmitter {
  stdinEnded = false;
  readonly stdin = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
    final: (callback) => {
      this.stdinEnded = true;
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
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const jpeg = (fill: number, size = 64) =>
  Buffer.from([0xff, 0xd8, 0xff, ...Array(size).fill(fill)]);
const record = (payload: Buffer) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength);
  return Buffer.concat([header, payload]);
};

describe("FaceTime video capture", () => {
  const warn = vi.fn();
  let helper: FakeHelper;
  let capture: ReturnType<typeof startFaceTimeVideoCapture>;
  const start = () => {
    capture = startFaceTimeVideoCapture({
      captureBinary: "/libexec/facetime-video-capture",
      logger: { ...console, warn },
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    warn.mockReset();
    spawnMock.mockReset().mockImplementation(() => (helper = new FakeHelper()));
  });
  afterEach(async () => {
    await capture.stop();
    vi.useRealTimers();
  });

  it("starts the helper without Gateway credentials and reports no view until a frame arrives", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "sk-test", FACETIME_TEST_PLAIN: "kept" }, async () => {
      start();
    });

    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(command).toBe("/libexec/facetime-video-capture");
    expect(args).toEqual([
      "--interval-ms",
      "2000",
      "--max-dimension",
      "768",
      "--jpeg-quality",
      "0.6",
    ]);
    expect(options?.env).toMatchObject({ FACETIME_TEST_PLAIN: "kept" });
    expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(capture.read()).toEqual({ unavailable: "FaceTime video capture is starting" });
  });

  it("keeps only the newest frame from records split across pipe chunks", () => {
    start();
    const stream = Buffer.concat([record(jpeg(1)), record(jpeg(2)), record(jpeg(3))]);

    helper.stdout.emit("data", stream.subarray(0, 2));
    helper.stdout.emit("data", stream.subarray(2, 90));
    expect(capture.read()).toEqual({ frame: { jpeg: jpeg(1), capturedAtMs: Date.now() } });
    helper.stdout.emit("data", stream.subarray(90));

    expect(capture.read()).toEqual({ frame: { jpeg: jpeg(3), capturedAtMs: Date.now() } });
  });

  it("withholds a view that went stale or whose window left the screen", () => {
    start();
    helper.stdout.emit("data", record(jpeg(1)));

    vi.advanceTimersByTime(6_001);
    expect(capture.read()).toEqual({ unavailable: "the last video frame is too old" });

    helper.stdout.emit("data", record(jpeg(2)));
    helper.stderr.emit("data", "facetime-video-capture: window unava");
    expect(capture.read()).toHaveProperty("frame");
    helper.stderr.emit("data", "ilable\n");
    expect(capture.read()).toEqual({
      unavailable: "no FaceTime call window is visible on the Mac right now",
    });

    helper.stdout.emit("data", record(jpeg(3)));
    expect(capture.read()).toHaveProperty("frame");
  });

  it.each([
    [
      "an oversized length",
      Buffer.from([0x01, 0x00, 0x10, 0x01]),
      "invalid frame length (17825793)",
    ],
    ["a zero length", Buffer.alloc(4), "invalid frame length (0)"],
    ["a payload that is not a JPEG", record(Buffer.from("not an image")), "not a JPEG"],
  ])("stops the helper and drops the view after %s", (_name, bytes, reason) => {
    start();
    helper.stdout.emit("data", record(jpeg(1)));

    helper.stdout.emit("data", bytes);

    expect(capture.read()).toEqual({ unavailable: expect.stringContaining(reason) });
    expect(helper.kills).toEqual(["SIGTERM"]);
    expect(warn).toHaveBeenCalledOnce();
    helper.stdout.emit("data", record(jpeg(2)));
    expect(capture.read()).not.toHaveProperty("frame");
  });

  it("reports the helper's own fatal reason and its exit", () => {
    start();

    helper.stderr.emit(
      "data",
      "facetime-video-capture: fatal: Screen Recording permission is not granted\n",
    );
    expect(capture.read()).toEqual({ unavailable: "Screen Recording permission is not granted" });

    start();
    helper.emit("exit", 77, null);
    expect(capture.read()).toEqual({ unavailable: "video capture helper exited (77)" });
    expect(helper.kills).toEqual([]);
  });

  it("closes the helper's stdin and forgets the frame when the call ends", async () => {
    start();
    helper.stdout.emit("data", record(jpeg(1)));

    await capture.stop();

    expect(helper.stdinEnded).toBe(true);
    expect(helper.kills).toEqual(["SIGTERM"]);
    expect(capture.read()).toEqual({ unavailable: "the call has ended" });
    expect(warn).not.toHaveBeenCalled();
  });
});
