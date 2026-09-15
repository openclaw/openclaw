import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Writable } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

type PumpProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: (Writable & { writableLength?: number }) | null;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"];
  },
) => PumpProcess;

const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";
const CAPTURE_CLOSE_SAFE_FRAME = Buffer.from([4, 0, 0, 0, 4, 0, 0, 0, 0]);
const FACETIME_AUDIO_SAMPLE_RATE_HZ = 24_000;
const OUTPUT_LATENCY_BUDGET_MS = 100;
// The paired device renders 48 kHz float32 stereo. This gives Core Audio about
// 21 ms of output buffering, enough to survive ordinary scheduler jitter.
const SOX_COREAUDIO_BUFFER_BYTES = 8 * 1024;
const SOX_COMMAND =
  [
    process.env.HOME ? `${process.env.HOME}/.homebrew/bin/sox` : undefined,
    "/opt/homebrew/bin/sox",
    "/usr/local/bin/sox",
  ].find((path): path is string => Boolean(path && existsSync(path))) ?? "sox";
export const FACETIME_FEED_DEVICE_NAME = "OpenClaw-Feed";
export const FACETIME_MIC_DEVICE_NAME = "OpenClaw-Mic";
const MAX_PLAYBACK_BUFFERED_BYTES = 2 * 1024 * 1024;

type FaceTimeAudioPump = {
  suppressionReady(): Promise<void>;
  routeReady(): Promise<void>;
  processOutputSuppressed(): boolean;
  writeOutputAudio(audio: Buffer): void;
  finishOutputAudio(): void;
  clearOutputAudio(): void;
  playedAudioFrames(): number;
  queuedAudioFrames(): number;
  suspendMedia(): Promise<void>;
  failClosed(): Promise<void>;
  stop(): Promise<void>;
};

function sanitizedAudioChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/iu.test(key),
    ),
  );
}

class PlaybackClock {
  private generatedFrames = 0;
  private playedFramesBeforeSegment = 0;
  private playbackStartsAtMs = 0;
  private playbackUntilMs = 0;

  append(frames: number, nowMs = Date.now()): void {
    if (nowMs >= this.playbackUntilMs) {
      this.playedFramesBeforeSegment = this.generatedFrames;
      this.playbackStartsAtMs = nowMs + OUTPUT_LATENCY_BUDGET_MS;
      this.playbackUntilMs = this.playbackStartsAtMs;
    }
    this.generatedFrames += frames;
    this.playbackUntilMs += (frames / FACETIME_AUDIO_SAMPLE_RATE_HZ) * 1000;
  }

  playedFrames(nowMs = Date.now()): number {
    if (nowMs <= this.playbackStartsAtMs) {
      return this.playedFramesBeforeSegment;
    }
    const elapsedFrames =
      ((nowMs - this.playbackStartsAtMs) / 1000) * FACETIME_AUDIO_SAMPLE_RATE_HZ;
    return Math.min(this.generatedFrames, this.playedFramesBeforeSegment + elapsedFrames);
  }

  queuedFrames(nowMs = Date.now()): number {
    return Math.max(0, this.generatedFrames - this.playedFrames(nowMs));
  }

  millisecondsUntilDrained(nowMs = Date.now()): number {
    return Math.max(0, this.playbackUntilMs - nowMs);
  }

  reset(): void {
    this.generatedFrames = 0;
    this.playedFramesBeforeSegment = 0;
    this.playbackStartsAtMs = 0;
    this.playbackUntilMs = 0;
  }
}

function buildSoxOutputArguments(): string[] {
  return [
    "-q",
    "--buffer",
    String(SOX_COREAUDIO_BUFFER_BYTES),
    "-t",
    "raw",
    "-r",
    String(FACETIME_AUDIO_SAMPLE_RATE_HZ),
    "-c",
    "1",
    "-e",
    "signed-integer",
    "-b",
    "16",
    "-L",
    "-",
    "-t",
    "coreaudio",
    FACETIME_FEED_DEVICE_NAME,
  ];
}

async function terminateProcess(proc: PumpProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (proc.killed && signal !== "SIGKILL") {
    return;
  }
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => {
    proc.on("exit", () => {
      exited = true;
      resolve();
    });
  });
  try {
    proc.kill(signal);
  } catch {
    return;
  }
  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    }),
  ]);
  if (!exited && signal !== "SIGKILL") {
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      }),
    ]);
  }
}

export function startFaceTimeAudioPump(params: {
  captureBinary: string;
  logger: RuntimeLogger;
  onInputAudio: (audio: Buffer) => void;
  onError?: (error: Error) => boolean | void | Promise<boolean | void>;
  onSuppressionLost?: (error: Error) => void | Promise<void>;
  onPlaybackDrained?: (event: { generation: number; playedFrames: number }) => void;
  spawn?: SpawnFn;
}): FaceTimeAudioPump {
  const spawnFn: SpawnFn =
    params.spawn ?? ((command, args, options) => spawn(command, args, options));
  const childEnv = sanitizedAudioChildEnv();
  const playbackClock = new PlaybackClock();
  let playbackGeneration = 1;
  let drainTimer: NodeJS.Timeout | undefined;
  let outputProcess: PumpProcess;
  const captureProcess = spawnFn(params.captureBinary, [], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stopped = false;
  let mediaSuspended = false;
  let captureSuppressionActive = false;
  let captureFailureReported = false;
  let captureReadySettled = false;
  let routeReadySettled = false;
  let routeReadyTimer: NodeJS.Timeout | undefined;
  let captureStderr = "";
  let resolveCaptureReady = () => {};
  let rejectCaptureReady = (_error: Error) => {};
  const captureReadyPromise = new Promise<void>((resolve, reject) => {
    resolveCaptureReady = resolve;
    rejectCaptureReady = reject;
  });
  let resolveRouteReady = () => {};
  let rejectRouteReady = (_error: Error) => {};
  const routeReadyPromise = new Promise<void>((resolve, reject) => {
    resolveRouteReady = resolve;
    rejectRouteReady = reject;
  });
  void captureReadyPromise.catch(() => {});
  void routeReadyPromise.catch(() => {});

  const settleCaptureReady = (error?: Error) => {
    if (captureReadySettled) {
      return;
    }
    captureReadySettled = true;
    clearTimeout(captureReadyTimer);
    if (error) {
      rejectCaptureReady(error);
    } else {
      resolveCaptureReady();
    }
  };
  const settleRouteReady = (error?: Error) => {
    if (routeReadySettled) {
      return;
    }
    routeReadySettled = true;
    if (routeReadyTimer) {
      clearTimeout(routeReadyTimer);
      routeReadyTimer = undefined;
    }
    if (error) {
      rejectRouteReady(error);
    } else {
      resolveRouteReady();
    }
  };
  const reportFailure = (error: Error, suppressionLost: boolean) => {
    if (stopped) {
      return;
    }
    if (suppressionLost) {
      captureSuppressionActive = false;
      void params.onSuppressionLost?.(error);
    }
    settleCaptureReady(error);
    settleRouteReady(error);
    params.logger.warn(`[facetime] native audio bridge failed: ${formatErrorMessage(error)}`);
    void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
      if (safeToStop !== false) {
        void stop();
      }
    });
  };
  const cancelDrainTimer = () => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  };
  const spawnOutput = () => {
    // Playback stays out of the capture helper: an in-process AVAudioEngine can
    // rebind OpenClaw-Feed after FaceTime claims it and tear down the carrier.
    const proc = spawnFn(SOX_COMMAND, buildSoxOutputArguments(), {
      env: childEnv,
      stdio: ["pipe", "ignore", "pipe"],
    });
    proc.on("error", (error) => {
      if (!stopped && !mediaSuspended && proc === outputProcess) {
        reportFailure(error, false);
      }
    });
    proc.stdin?.on("error", (error) => {
      if (!stopped && !mediaSuspended && proc === outputProcess) {
        reportFailure(error, false);
      }
    });
    proc.on("exit", (code, signal) => {
      if (!stopped && !mediaSuspended && proc === outputProcess) {
        reportFailure(new Error(`SoX playback exited (${code ?? signal ?? "done"})`), false);
      }
    });
    proc.stderr?.on("data", (chunk) => {
      if (proc === outputProcess) {
        params.logger.debug?.(`[facetime] SoX playback: ${String(chunk).trim()}`);
      }
    });
    return proc;
  };
  outputProcess = spawnOutput();
  const captureReadyTimer = setTimeout(() => {
    reportFailure(new Error("FaceTime process tap was not ready within 10 seconds"), true);
  }, 10_000);
  captureReadyTimer.unref?.();
  const startRouteReadyTimer = () => {
    if (routeReadySettled || routeReadyTimer) {
      return;
    }
    routeReadyTimer = setTimeout(() => {
      reportFailure(new Error("FaceTime input route was not verified within 15 seconds"), true);
    }, 15_000);
    routeReadyTimer.unref?.();
  };
  const clearPlayback = () => {
    if (stopped || mediaSuspended) {
      return;
    }
    const previous = outputProcess;
    outputProcess = spawnOutput();
    playbackGeneration += 1;
    cancelDrainTimer();
    playbackClock.reset();
    void terminateProcess(previous, "SIGKILL");
  };
  const stop = async () => {
    if (stopped) {
      return;
    }
    mediaSuspended = true;
    captureSuppressionActive = false;
    settleCaptureReady(new Error("FaceTime native audio bridge stopped before readiness"));
    settleRouteReady(new Error("FaceTime input route stopped before verification"));
    cancelDrainTimer();
    try {
      captureProcess.stdin?.write(CAPTURE_CLOSE_SAFE_FRAME);
      captureProcess.stdin?.end();
    } catch {
      // Process exit below remains joined.
    }
    stopped = true;
    await Promise.all([
      terminateProcess(captureProcess),
      terminateProcess(outputProcess, "SIGKILL"),
      wakeProcess ? terminateProcess(wakeProcess) : Promise.resolve(),
    ]);
  };
  const failClosed = async () => {
    if (stopped) {
      return;
    }
    mediaSuspended = true;
    stopped = true;
    cancelDrainTimer();
    playbackClock.reset();
    try {
      // No close-safe frame: EOF is the native watchdog's fail-closed signal.
      captureProcess.stdin?.end();
    } catch {
      // The process may already be handling EOF.
    }
    let exited = false;
    const exitedPromise = new Promise<void>((resolve) => {
      captureProcess.on("exit", () => {
        exited = true;
        resolve();
      });
    });
    // Stop queued model speech before waiting for the carrier watchdog. The
    // native capture process retains hardware suppression during that wait.
    const outputStopped = terminateProcess(outputProcess, "SIGKILL");
    const wakeStopped = wakeProcess ? terminateProcess(wakeProcess) : Promise.resolve();
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        timer.unref?.();
      }),
    ]);
    await Promise.all([
      exited ? Promise.resolve() : terminateProcess(captureProcess),
      outputStopped,
      wakeStopped,
    ]);
    captureSuppressionActive = false;
  };

  const wakeProcess = existsSync(CAFFEINATE_COMMAND)
    ? spawnFn(
        CAFFEINATE_COMMAND,
        ["-d", "-i", ...(captureProcess.pid ? ["-w", String(captureProcess.pid)] : [])],
        { env: childEnv, stdio: ["ignore", "ignore", "pipe"] },
      )
    : undefined;
  wakeProcess?.on("error", () => undefined);
  captureProcess.on("error", (error) => reportFailure(error, true));
  captureProcess.stdin?.on("error", (error) => reportFailure(error, false));
  captureProcess.on("exit", (code, signal) => {
    if (!stopped) {
      reportFailure(new Error(`native audio bridge exited (${code ?? signal ?? "done"})`), true);
    }
  });
  captureProcess.stderr?.on("data", (chunk) => {
    const message = String(chunk);
    captureStderr = `${captureStderr}${message}`.slice(-8192);
    for (const line of captureStderr.split(/\r?\n/u).slice(0, -1)) {
      if (line.includes("started FaceTime process tap")) {
        captureSuppressionActive = true;
        settleCaptureReady();
      }
      if (line.includes("verified OpenClaw-Mic input route")) {
        settleRouteReady();
      }
      if (
        !captureFailureReported &&
        /facetime-audio-capture: fatal(?:-safety-retained)?:/u.test(line)
      ) {
        captureFailureReported = true;
        reportFailure(new Error("native FaceTime safety monitor reported a fatal error"), false);
      }
    }
    captureStderr = captureStderr.split(/\r?\n/u).at(-1) ?? "";
  });
  captureProcess.stdout?.on("data", (chunk) => {
    if (!stopped && !mediaSuspended) {
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (audio.byteLength > 0) {
        params.onInputAudio(audio);
      }
    }
  });

  return {
    suppressionReady: async () => await captureReadyPromise,
    routeReady: async () => {
      startRouteReadyTimer();
      await routeReadyPromise;
    },
    processOutputSuppressed: () => captureSuppressionActive,
    writeOutputAudio(audio) {
      if (stopped || mediaSuspended || audio.byteLength === 0) {
        return;
      }
      const bufferedBytes = outputProcess.stdin?.writableLength ?? 0;
      if (bufferedBytes + audio.byteLength > MAX_PLAYBACK_BUFFERED_BYTES) {
        reportFailure(new Error("SoX playback queue exceeded 2 MiB"), false);
        return;
      }
      if (!outputProcess.stdin) {
        reportFailure(new Error("SoX playback stdin is unavailable"), false);
        return;
      }
      try {
        cancelDrainTimer();
        outputProcess.stdin.write(audio);
        playbackClock.append(audio.byteLength / 2);
      } catch (error) {
        reportFailure(error instanceof Error ? error : new Error(formatErrorMessage(error)), false);
      }
    },
    finishOutputAudio() {
      if (stopped || mediaSuspended || playbackClock.queuedFrames() <= 0) {
        return;
      }
      cancelDrainTimer();
      const generation = playbackGeneration;
      const notifyWhenDrained = () => {
        if (stopped || mediaSuspended || generation !== playbackGeneration) {
          return;
        }
        const delayMs = Math.ceil(playbackClock.millisecondsUntilDrained());
        if (delayMs > 0) {
          drainTimer = setTimeout(notifyWhenDrained, Math.max(1, delayMs));
          drainTimer.unref?.();
          return;
        }
        drainTimer = undefined;
        params.onPlaybackDrained?.({
          generation,
          playedFrames: Math.floor(playbackClock.playedFrames()),
        });
      };
      notifyWhenDrained();
    },
    clearOutputAudio: clearPlayback,
    playedAudioFrames: () => Math.floor(playbackClock.playedFrames()),
    queuedAudioFrames: () => Math.ceil(playbackClock.queuedFrames()),
    async suspendMedia() {
      if (!stopped && !mediaSuspended) {
        mediaSuspended = true;
        cancelDrainTimer();
        playbackClock.reset();
        await terminateProcess(outputProcess, "SIGKILL");
      }
    },
    failClosed,
    stop,
  };
}
