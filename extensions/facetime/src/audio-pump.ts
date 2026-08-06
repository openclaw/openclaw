import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Writable } from "node:stream";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { formatErrorMessage } from "./errors.js";
import { PlaybackClock } from "./playback-clock.js";

type PumpProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: Writable | null;
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

export const SOX_COMMAND =
  ["/opt/homebrew/bin/sox", "/usr/local/bin/sox"].find((path) => existsSync(path)) ?? "sox";
const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";
export const FACETIME_AUDIO_SAMPLE_RATE_HZ = 24_000;
export const FACETIME_FEED_DEVICE_NAME = "OpenClaw-Feed";
export const FACETIME_MIC_DEVICE_NAME = "OpenClaw-Mic";
export const MAX_PLAYBACK_BUFFERED_BYTES = 2 * 1024 * 1024;

export type FaceTimeAudioOutput = {
  writeOutputAudio(audio: Buffer): void;
  clearOutputAudio(): void;
  generatedAudioMs(): number;
  playedAudioMs(): number;
  queuedAudioMs(): number;
  stop(): Promise<void>;
};

export type FaceTimeAudioPump = FaceTimeAudioOutput & {
  suppressionReady(): Promise<void>;
  routeReady(): Promise<void>;
  processOutputSuppressed(): boolean;
  suspendMedia(): Promise<void>;
};

export function sanitizedAudioChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/iu.test(key),
    ),
  );
}

export function buildSoxOutputArguments(
  deviceName = FACETIME_FEED_DEVICE_NAME,
  bufferBytes = 480,
): string[] {
  return [
    "-q",
    "--buffer",
    String(bufferBytes),
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
    deviceName,
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
    proc.stdin?.end();
  } catch {
    // The process may already have closed stdin.
  }
  try {
    proc.kill(signal);
  } catch {
    return;
  }
  if (signal !== "SIGKILL") {
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
      }),
    ]);
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have exited after the grace check.
      }
    }
  }
  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
    }),
  ]);
}

export function startFaceTimeAudioOutput(params: {
  logger: RuntimeLogger;
  deviceName?: string;
  bufferBytes?: number;
  onError?: (error: Error) => boolean | void | Promise<boolean | void>;
  onPlaybackDrained?: () => void;
  spawn?: SpawnFn;
}): FaceTimeAudioOutput {
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as PumpProcess);
  const childEnv = sanitizedAudioChildEnv();
  const outputArgs = buildSoxOutputArguments(params.deviceName, params.bufferBytes);
  const clock = new PlaybackClock();
  let outputProcess: PumpProcess;
  let stopped = false;
  let drainTimer: NodeJS.Timeout | undefined;

  const cancelDrainTimer = () => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  };
  const schedulePlaybackDrain = () => {
    cancelDrainTimer();
    const delayMs = Math.ceil(clock.millisecondsUntilDrained());
    drainTimer = setTimeout(
      () => {
        drainTimer = undefined;
        if (!stopped && clock.queuedAudioMs() === 0) {
          params.onPlaybackDrained?.();
        } else if (!stopped) {
          schedulePlaybackDrain();
        }
      },
      Math.max(1, delayMs),
    );
    drainTimer.unref?.();
  };

  const fail = (error: Error) => {
    if (stopped) {
      return;
    }
    params.logger.warn(`[facetime] audio output failed: ${formatErrorMessage(error)}`);
    void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
      if (safeToStop !== false) {
        return stop();
      }
    });
  };
  const spawnOutput = () => {
    const proc = spawnFn(SOX_COMMAND, outputArgs, {
      env: childEnv,
      stdio: ["pipe", "ignore", "pipe"],
    });
    proc.on("error", (error) => {
      if (proc === outputProcess) {
        fail(error);
      }
    });
    proc.stdin?.on("error", (error) => {
      if (proc === outputProcess) {
        fail(error);
      }
    });
    proc.on("exit", (code, signal) => {
      if (!stopped && proc === outputProcess) {
        fail(new Error(`exited (${code ?? signal ?? "done"})`));
      }
    });
    proc.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`[facetime] audio output: ${String(chunk).trim()}`);
    });
    return proc;
  };
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    cancelDrainTimer();
    clock.reset();
    // SoX can retain speech that was already written to stdin. Kill it
    // immediately so a safety suspension cannot play queued model audio.
    await terminateProcess(outputProcess, "SIGKILL");
  };

  outputProcess = spawnOutput();
  return {
    writeOutputAudio(audio) {
      if (stopped || audio.byteLength === 0) {
        return;
      }
      const bufferedBytes = outputProcess.stdin?.writableLength ?? 0;
      if (bufferedBytes + audio.byteLength > MAX_PLAYBACK_BUFFERED_BYTES) {
        fail(new Error("playback queue exceeded 2 MiB"));
        return;
      }
      try {
        clock.append(audio.byteLength);
        outputProcess.stdin?.write(audio);
        schedulePlaybackDrain();
      } catch (error) {
        fail(error as Error);
      }
    },
    clearOutputAudio() {
      if (stopped) {
        return;
      }
      const previous = outputProcess;
      outputProcess = spawnOutput();
      cancelDrainTimer();
      clock.reset();
      void terminateProcess(previous, "SIGKILL");
    },
    generatedAudioMs() {
      return clock.totalGeneratedAudioMs();
    },
    playedAudioMs() {
      return clock.playedAudioMs();
    },
    queuedAudioMs() {
      return clock.queuedAudioMs();
    },
    stop,
  };
}

export function startFaceTimeAudioPump(params: {
  captureBinary: string;
  logger: RuntimeLogger;
  onInputAudio: (audio: Buffer) => void;
  onError?: (error: Error) => boolean | void | Promise<boolean | void>;
  onPlaybackDrained?: () => void;
  spawn?: SpawnFn;
}): FaceTimeAudioPump {
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as PumpProcess);
  const childEnv = sanitizedAudioChildEnv();
  let stopped = false;
  let mediaSuspended = false;
  let captureSuppressionActive = false;
  let captureFailureReported = false;
  const output = startFaceTimeAudioOutput({
    logger: params.logger,
    onError: params.onError,
    onPlaybackDrained: params.onPlaybackDrained,
    spawn: spawnFn,
  });
  const captureProcess = spawnFn(params.captureBinary, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  // A caller may stop immediately after spawn without awaiting readiness.
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
  const captureReadyTimer = setTimeout(() => {
    const error = new Error("FaceTime process-tap capture did not become ready within 10 seconds");
    settleCaptureReady(error);
    void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
      if (safeToStop !== false) {
        return stop();
      }
    });
  }, 10_000);
  captureReadyTimer.unref?.();
  const startRouteReadyTimer = () => {
    if (routeReadySettled || routeReadyTimer) {
      return;
    }
    routeReadyTimer = setTimeout(() => {
      const error = new Error("FaceTime input route was not verified within 15 seconds");
      settleRouteReady(error);
      void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
        if (safeToStop !== false) {
          return stop();
        }
      });
    }, 15_000);
    routeReadyTimer.unref?.();
  };
  const wakeProcess = existsSync(CAFFEINATE_COMMAND)
    ? spawnFn(
        CAFFEINATE_COMMAND,
        ["-d", "-i", ...(captureProcess.pid ? ["-w", String(captureProcess.pid)] : [])],
        {
          env: childEnv,
          stdio: ["ignore", "ignore", "pipe"],
        },
      )
    : undefined;

  const fail = (label: string) => (error: Error) => {
    if (stopped) {
      return;
    }
    params.logger.warn(`[facetime] ${label} failed: ${formatErrorMessage(error)}`);
    settleCaptureReady(error);
    settleRouteReady(error);
    void Promise.resolve(params.onError?.(error)).then((safeToStop) => {
      if (safeToStop !== false) {
        return stop();
      }
    });
  };
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    mediaSuspended = true;
    captureSuppressionActive = false;
    settleCaptureReady(new Error("FaceTime process-tap capture stopped before becoming ready"));
    settleRouteReady(new Error("FaceTime input route stopped before verification"));
    await Promise.all([
      terminateProcess(captureProcess),
      output.stop(),
      wakeProcess ? terminateProcess(wakeProcess) : Promise.resolve(),
    ]);
  };

  wakeProcess?.on("error", (error) => {
    params.logger.debug?.(`[facetime] caffeinate command failed: ${formatErrorMessage(error)}`);
  });
  wakeProcess?.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[facetime] caffeinate: ${String(chunk).trim()}`);
  });
  captureProcess.on("error", (error) => {
    captureSuppressionActive = false;
    fail("FaceTime process-tap capture")(error);
  });
  captureProcess.on("exit", (code, signal) => {
    captureSuppressionActive = false;
    if (!stopped) {
      fail("FaceTime process-tap capture")(new Error(`exited (${code ?? signal ?? "done"})`));
    }
  });
  captureProcess.stderr?.on("data", (chunk) => {
    const message = String(chunk);
    captureStderr = `${captureStderr}${message}`.slice(-4096);
    if (captureStderr.includes("started FaceTime process tap")) {
      captureSuppressionActive = true;
      settleCaptureReady();
    }
    if (captureStderr.includes("verified OpenClaw-Mic input route")) {
      settleRouteReady();
    }
    if (
      !captureFailureReported &&
      /facetime-audio-capture: fatal(?:-safety-retained)?:/u.test(captureStderr)
    ) {
      captureFailureReported = true;
      fail("FaceTime process-tap capture")(new Error(message.trim()));
    }
    params.logger.debug?.(`[facetime] capture: ${message.trim()}`);
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
    async suspendMedia() {
      if (stopped || mediaSuspended) {
        return;
      }
      // Carrier cleanup can be uncertain. Stop model playback and input
      // forwarding, but retain the native tap that suppresses Mac hardware.
      mediaSuspended = true;
      await output.stop();
    },
    writeOutputAudio: output.writeOutputAudio,
    clearOutputAudio: output.clearOutputAudio,
    generatedAudioMs: output.generatedAudioMs,
    playedAudioMs: output.playedAudioMs,
    queuedAudioMs: output.queuedAudioMs,
    stop,
  };
}
