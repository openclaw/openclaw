import { spawn } from "node:child_process";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { sanitizedCaptureChildEnv, terminateProcess } from "./audio-pump.js";

const FRAME_INTERVAL_MS = 2_000;
const FRAME_MAX_DIMENSION_PX = 768;
const FRAME_JPEG_QUALITY = 0.6;
// A 768 px JPEG at this quality is about 60-150 KiB. Anything near the cap is a helper fault.
const MAX_FRAME_BYTES = 1024 * 1024;
// The view is "current" for three capture intervals; older frames are never shown to the model.
const FRAME_MAX_AGE_MS = FRAME_INTERVAL_MS * 3;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export type FaceTimeVideoFrame = { jpeg: Buffer; capturedAtMs: number };

export type FaceTimeVideoCapture = {
  /** The newest current frame, or why there is none. Frames exist only in this process's memory. */
  read: () => { frame: FaceTimeVideoFrame } | { unavailable: string };
  stop: () => Promise<void>;
};

/**
 * Runs the native FaceTime window capture helper for one call. Its stdout is a stream of
 * records: a little-endian uint32 byte length, then one JPEG. Only the newest frame is kept.
 * Capture failure never touches the audio path: the call continues without sight.
 */
export function startFaceTimeVideoCapture(params: {
  captureBinary: string;
  logger: RuntimeLogger;
}): FaceTimeVideoCapture {
  const child = spawn(
    params.captureBinary,
    [
      "--interval-ms",
      String(FRAME_INTERVAL_MS),
      "--max-dimension",
      String(FRAME_MAX_DIMENSION_PX),
      "--jpeg-quality",
      String(FRAME_JPEG_QUALITY),
    ],
    { env: sanitizedCaptureChildEnv(), stdio: ["pipe", "pipe", "pipe"] },
  );
  let latest: FaceTimeVideoFrame | undefined;
  let pending: Buffer = Buffer.alloc(0);
  let stderrTail = "";
  let unavailable = "FaceTime video capture is starting";
  let stopped = false;
  let failed = false;
  let exited = false;

  const fail = (reason: string) => {
    if (stopped || failed) {
      return;
    }
    failed = true;
    latest = undefined;
    pending = Buffer.alloc(0);
    unavailable = reason;
    params.logger.warn(
      `[facetime] video capture stopped; the call continues without it: ${reason}`,
    );
    if (!exited) {
      void terminateProcess(child);
    }
  };

  child.on("error", (error) => {
    exited = true;
    fail(`video capture helper failed to start: ${error.message}`);
  });
  child.stdin?.on("error", () => undefined);
  child.on("exit", (code, signal) => {
    exited = true;
    fail(`video capture helper exited (${code ?? signal ?? "done"})`);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stopped || failed) {
      return;
    }
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.byteLength >= 4) {
      const length = pending.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        fail(`video capture helper sent an invalid frame length (${length})`);
        return;
      }
      if (pending.byteLength < 4 + length) {
        return;
      }
      const jpeg = Buffer.from(pending.subarray(4, 4 + length));
      pending = pending.subarray(4 + length);
      if (!jpeg.subarray(0, JPEG_MAGIC.byteLength).equals(JPEG_MAGIC)) {
        fail("video capture helper sent a frame that is not a JPEG");
        return;
      }
      latest = { jpeg, capturedAtMs: Date.now() };
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4096);
    const lines = stderrTail.split(/\r?\n/u);
    stderrTail = lines.pop() ?? "";
    for (const line of lines) {
      const fatal = line.match(/facetime-video-capture: fatal:\s*(.*)$/u);
      if (fatal) {
        fail(fatal[1]?.trim() || "video capture helper reported a fatal error");
      } else if (line.includes("facetime-video-capture: window unavailable")) {
        // The call window left the screen. Drop the last view instead of letting it go stale.
        latest = undefined;
        unavailable = "no FaceTime call window is visible on the Mac right now";
      } else if (line.trim()) {
        params.logger.debug?.(`[facetime] ${line.trim()}`);
      }
    }
  });

  return {
    read() {
      if (stopped) {
        return { unavailable: "the call has ended" };
      }
      if (latest && Date.now() - latest.capturedAtMs <= FRAME_MAX_AGE_MS) {
        return { frame: latest };
      }
      return { unavailable: latest ? "the last video frame is too old" : unavailable };
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      latest = undefined;
      pending = Buffer.alloc(0);
      if (!exited) {
        // The helper exits on stdin EOF; the signal covers a helper that is not reading.
        child.stdin?.end();
        await terminateProcess(child);
      }
    },
  };
}
