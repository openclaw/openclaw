import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AUDIO_COMMAND = "device-controls.audio";
const MAX_DURATION_MS = 10_000;
const SAMPLE_RATE = 24_000;
type Note = { frequencyHz: number; durationMs: number };
export type AudioRequest =
  | { operation: "play"; operationId: string; notes: Note[]; volume: number }
  | { operation: "stop"; operationId: string };
export type AudioSink = (wav: Buffer, signal: AbortSignal) => Promise<void>;

export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  // SAFETY: the object and array checks above narrow JSON input to a record.
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown parameter");
  }
  return record;
}

export function boundedNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Expected a finite number from ${min} to ${max}`);
  }
  return value;
}

export function parseAudio(value: unknown): AudioRequest {
  const request = object(value, ["operation", "operationId", "notes", "volume"]);
  if (
    typeof request.operationId !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(request.operationId)
  ) {
    throw new Error("operationId must be a UUID");
  }
  if (request.operation === "stop") {
    if (request.notes !== undefined || request.volume !== undefined) {
      throw new Error("Stop does not accept notes or volume");
    }
    return { operation: "stop", operationId: request.operationId };
  }
  if (
    request.operation !== "play" ||
    !Array.isArray(request.notes) ||
    !request.notes.length ||
    request.notes.length > 32
  ) {
    throw new Error("Play requires 1–32 notes");
  }
  const notes = request.notes.map((input) => {
    const note = object(input, ["frequencyHz", "durationMs"]);
    return {
      frequencyHz: boundedNumber(note.frequencyHz, 20, 8_000),
      durationMs: boundedNumber(note.durationMs, 20, 2_000),
    };
  });
  if (notes.reduce((sum, note) => sum + note.durationMs, 0) > MAX_DURATION_MS) {
    throw new Error("Audio is limited to ten seconds");
  }
  return {
    operation: "play",
    operationId: request.operationId,
    notes,
    volume: boundedNumber(request.volume ?? 0.1, 0, 0.25),
  };
}

/** Bounded mono PCM with short fades; no filenames, URLs or executable input. */
function renderWav(notes: readonly Note[], volume: number): Buffer {
  const frames = notes.map((note) => ({
    note,
    count: Math.round((note.durationMs * SAMPLE_RATE) / 1_000),
  }));
  const samples = frames.reduce((sum, { count }) => sum + count, 0);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const { note, count } of frames) {
    const fade = Math.min(120, count / 2);
    for (let sample = 0; sample < count; sample++) {
      const envelope = Math.min(1, sample / fade, (count - 1 - sample) / fade);
      const value = Math.sin((2 * Math.PI * note.frequencyHz * sample) / SAMPLE_RATE);
      wav.writeInt16LE(Math.round(value * envelope * volume * 32_767), offset);
      offset += 2;
    }
  }
  return wav;
}

/** Fixed native player, private temporary input, cancellation waits for child exit. */
const playWav: AudioSink = async (wav, signal) => {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "openclaw-device-audio-"));
  try {
    const filename = join(directory, "sequence.wav");
    await writeFile(filename, wav, { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/afplay", [filename], {
        shell: false,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
      };
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(killTimer);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
      }
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Playback cancelled"));
        } else if (code !== 0) {
          reject(new Error(`Native audio player exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** One active playback per executor. A fixed operation UUID is a control capability. */
export class AudioExecutor {
  private active?: {
    id: string;
    abort: AbortController;
    signal: AbortSignal;
    stopRequested: boolean;
    done: Promise<void>;
  };

  constructor(private readonly sink: AudioSink = playWav) {}

  get busy(): boolean {
    return this.active !== undefined;
  }

  async execute(
    value: unknown,
    externalSignal?: AbortSignal,
  ): Promise<{ status: "completed" | "stopped" }> {
    const request = parseAudio(value);
    externalSignal?.throwIfAborted();
    if (request.operation === "stop") {
      if (this.active && this.active.id !== request.operationId) {
        throw new Error("Operation does not own active playback");
      }
      if (this.active) {
        this.active.stopRequested = true;
      }
      await this.disconnect();
      return { status: "stopped" };
    }
    if (this.active) {
      throw new Error("Audio executor is busy; do not replay an uncertain invocation");
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      ...(externalSignal ? [externalSignal] : []),
      AbortSignal.timeout(MAX_DURATION_MS + 2_000),
    ]);
    const active = {
      id: request.operationId,
      abort,
      signal,
      stopRequested: false,
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.sink(renderWav(request.notes, request.volume), signal);
    });
    try {
      await active.done;
      return { status: "completed" };
    } catch (error) {
      if (active.stopRequested && error === active.abort.signal.reason) {
        return { status: "stopped" };
      }
      throw error;
    } finally {
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }

  async disconnect(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    active.abort.abort(new Error("Playback stopped"));
    await active.done.catch((error: unknown) => {
      if (error !== active.signal.reason) {
        throw error;
      }
    });
  }
}
