import type { MessagePort } from "node:worker_threads";
import type { JoinVoiceChannelOptions, CreateVoiceConnectionOptions } from "@discordjs/voice";
import type {
  GatewayVoiceServerUpdateDispatchData,
  GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

export type DiscordAudioWorkerOptions = Omit<
  JoinVoiceChannelOptions & CreateVoiceConnectionOptions,
  "adapterCreator"
> & {
  connectTimeoutMs: number;
  reconnectGraceMs: number;
  captureSilenceGraceMs: number;
  realtime: boolean;
};

export type DiscordAudioError = {
  message: string;
  name: string;
  code?: number;
  codeName?: string;
  operation?: string;
  daveRecoveryFailed?: boolean;
};
export type DiscordAudioFrame = {
  pcm: Uint8Array;
  packet: Uint8Array;
  receivedAt: number;
  recordingEpoch: bigint;
};

// Playback counters are worker-owned. The status word also carries main-thread
// input reservations, so starvation cannot retire an already admitted IPC chunk.
export const DISCORD_AUDIO_CLOCK_BYTES = 24;
export const DISCORD_AUDIO_PLAYED_BYTES = 0;
const DISCORD_AUDIO_OUTPUT_STATUS = 1;
export const DISCORD_AUDIO_STARTED = 2;
export const DISCORD_CONTINUOUS_CLOCK_BYTES = 24;
export const DISCORD_CONTINUOUS_ACTIVE = 0;
export const DISCORD_CONTINUOUS_SOURCE_BYTES = 1;
// Main arms +epoch, the worker claims -epoch at playback start, and main retires to zero.
export const DISCORD_CONTINUOUS_EXACT_SPEECH = 2;
export const DiscordAudioOutputStatus = {
  Buffering: 0n,
  Playing: 1n,
  Retiring: 2n,
  Closed: 3n,
} as const;
const OUTPUT_STATUS_MASK = 3n;
const OUTPUT_INPUT_RESERVATION = 4n;

export function getDiscordAudioOutputStatus(clock: BigInt64Array): bigint {
  return Atomics.load(clock, DISCORD_AUDIO_OUTPUT_STATUS) & OUTPUT_STATUS_MASK;
}

export function setDiscordAudioOutputStatus(clock: BigInt64Array, status: bigint): void {
  for (;;) {
    const current = Atomics.load(clock, DISCORD_AUDIO_OUTPUT_STATUS);
    if ((current & OUTPUT_STATUS_MASK) >= status) {
      return;
    }
    const next = (current & ~OUTPUT_STATUS_MASK) | status;
    if (Atomics.compareExchange(clock, DISCORD_AUDIO_OUTPUT_STATUS, current, next) === current) {
      return;
    }
  }
}

export function admitDiscordAudioInput(clock: BigInt64Array): boolean {
  for (;;) {
    const current = Atomics.load(clock, DISCORD_AUDIO_OUTPUT_STATUS);
    if ((current & OUTPUT_STATUS_MASK) >= DiscordAudioOutputStatus.Retiring) {
      return false;
    }
    if (
      Atomics.compareExchange(
        clock,
        DISCORD_AUDIO_OUTPUT_STATUS,
        current,
        current + OUTPUT_INPUT_RESERVATION,
      ) === current
    ) {
      return true;
    }
  }
}

export function releaseDiscordAudioInput(clock: BigInt64Array): void {
  Atomics.sub(clock, DISCORD_AUDIO_OUTPUT_STATUS, OUTPUT_INPUT_RESERVATION);
}

export function retireDiscordAudioOutput(clock: BigInt64Array): boolean {
  for (;;) {
    const current = Atomics.load(clock, DISCORD_AUDIO_OUTPUT_STATUS);
    if ((current & OUTPUT_STATUS_MASK) >= DiscordAudioOutputStatus.Retiring) {
      return true;
    }
    if (current >= OUTPUT_INPUT_RESERVATION) {
      return false;
    }
    if (
      Atomics.compareExchange(
        clock,
        DISCORD_AUDIO_OUTPUT_STATUS,
        current,
        DiscordAudioOutputStatus.Retiring,
      ) === current
    ) {
      return true;
    }
  }
}

export type DiscordAudioCommand =
  | { type: "gateway-server"; data: GatewayVoiceServerUpdateDispatchData }
  | { type: "gateway-state"; data: GatewayVoiceStateUpdateDispatchData }
  | { type: "gateway-failed" }
  | { type: "stop" }
  | {
      type: "continuous-port";
      id: number;
      enabled: boolean;
      port: MessagePort;
      state: SharedArrayBuffer;
      clock: SharedArrayBuffer;
    }
  | { type: "continuous-clear"; id: number }
  | { type: "continuous-flush"; id: number; marker: number }
  | { type: "continuous-activate"; id: number }
  | { type: "continuous-close"; id: number }
  | { type: "capture"; id: number; userId: string; recordingEpoch: SharedArrayBuffer }
  | { type: "capture-stop"; id: number }
  | { type: "capture-ack"; id: number; bytes: number }
  | { type: "passthrough"; reason: string; expirySeconds: number }
  | { type: "output-create"; id: number; continuous: boolean; clock: SharedArrayBuffer }
  | { type: "output-audio"; id: number; audio: Uint8Array; audible: boolean }
  | { type: "output-mark"; id: number; markId: number }
  | { type: "output-finish"; id: number; reason: string; playBuffered: boolean }
  | { type: "output-close"; id: number; reason: string }
  | { type: "output-hold"; hold: boolean }
  | { type: "output-shutdown" }
  | { type: "player-stop" }
  | { type: "file-play"; id: number; path: string }
  | { type: "stream-play"; id: number }
  | { type: "stream-chunk"; id: number; audio: Uint8Array }
  | { type: "stream-end"; id: number };

export type DiscordAudioEvent =
  | { type: "gateway-send"; payload: import("discord-api-types/v10").GatewaySendPayload }
  | { type: "gateway-destroy" }
  | { type: "ready" }
  | { type: "continuous-start"; id: number; speechEpoch: bigint }
  | { type: "continuous-idle"; id: number; speechEpoch: bigint }
  | { type: "continuous-flushed"; id: number; marker: number }
  | { type: "continuous-error"; id: number; error: DiscordAudioError }
  | { type: "stopped" }
  | { type: "connection"; status: string }
  | { type: "player"; status: string }
  | { type: "speaking"; userId: string; speaking: boolean }
  | { type: "capture-frame"; id: number; frame: DiscordAudioFrame }
  | { type: "capture-finalized"; id: number }
  | { type: "capture-end"; id: number }
  | { type: "capture-error"; id: number; error: DiscordAudioError }
  | { type: "output-start"; id: number }
  | { type: "output-close"; id: number; reason: string }
  | { type: "output-mark"; id: number; markId: number }
  | { type: "output-error"; id: number; error: DiscordAudioError }
  | { type: "file-end"; id: number; error?: DiscordAudioError }
  | { type: "stream-drain"; id: number }
  | { type: "error"; error: DiscordAudioError }
  | { type: "log"; level: "warn" | "verbose"; message: string };

export function serializeDiscordAudioError(error: unknown): DiscordAudioError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...("code" in error && typeof error.code === "number" ? { code: error.code } : {}),
    ...("codeName" in error && typeof error.codeName === "string"
      ? { codeName: error.codeName }
      : {}),
    ...("operation" in error && typeof error.operation === "string"
      ? { operation: error.operation }
      : {}),
  };
}

export function restoreDiscordAudioError(error: DiscordAudioError): Error & DiscordAudioError {
  return Object.assign(new Error(error.message), error);
}
