import type { Worker } from "node:worker_threads";
import {
  createCpuTrackedWorker,
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerArgv,
} from "openclaw/plugin-sdk/process-runtime";
import type { DiscordAudioEvent, DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";

export type DiscordAudioWorkerThread = Pick<Worker, "postMessage" | "terminate"> & {
  on(event: "message", listener: (event: DiscordAudioEvent) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
};

/** Source, core-bundled and standalone plugin workers use the same launch owner. */
export function createDiscordAudioWorkerThread(
  options: DiscordAudioWorkerOptions,
): DiscordAudioWorkerThread {
  const url = resolveRuntimeWorkerUrl(
    createPluginRuntimeProcessEntrypoint("discordAudio", import.meta.url),
  );
  const workerOptions = {
    workerData: options,
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  };
  return createCpuTrackedWorker(url, workerOptions);
}
