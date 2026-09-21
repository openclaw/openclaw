import { Worker } from "node:worker_threads";
import {
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerArgv,
} from "openclaw/plugin-sdk/process-runtime";
import type { DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";

export type DiscordAudioWorkerThread = Pick<Worker, "on" | "once" | "postMessage" | "terminate">;

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
  return new Worker(url, {
    workerData: options,
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  });
}
