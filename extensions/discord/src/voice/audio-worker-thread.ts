import type { Worker } from "node:worker_threads";
import {
  createCpuTrackedWorker,
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
  const url = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "audio-worker.runtime",
    distWorkerPath: "extensions/discord/src/voice/audio-worker.runtime.js",
    package: { name: "@openclaw/discord", distWorkerPath: "src/voice/audio-worker.runtime.js" },
  });
  return createCpuTrackedWorker(url, {
    workerData: options,
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  });
}
