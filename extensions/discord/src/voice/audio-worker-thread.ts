import { Worker } from "node:worker_threads";
import * as processRuntimeSdk from "openclaw/plugin-sdk/process-runtime";
import {
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerArgv,
} from "openclaw/plugin-sdk/process-runtime";
import type { DiscordAudioEvent, DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";

// Remove the native constructor path when the supported host floor includes worker accounting.
const workerSdk: Partial<Pick<typeof processRuntimeSdk, "createCpuTrackedWorker">> =
  processRuntimeSdk;

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
  const workerOptions = {
    workerData: options,
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  };
  return workerSdk.createCpuTrackedWorker
    ? workerSdk.createCpuTrackedWorker(url, workerOptions)
    : new Worker(url, workerOptions);
}
