import { Worker } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import type { DiscordAudioEvent, DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";
import { createDiscordAudioWorkerThread } from "./audio-worker-thread.js";

const host = vi.hoisted(() => ({
  trackedWorkerAvailable: true,
  createTrackedWorker: vi.fn<(...args: ConstructorParameters<typeof Worker>) => Worker>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  get createCpuTrackedWorker() {
    return host.trackedWorkerAvailable ? host.createTrackedWorker : undefined;
  },
  resolveRuntimeWorkerUrl: () =>
    new URL(
      `data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    parentPort.postMessage({ type: "log", level: "verbose", message: JSON.stringify(workerData) });
    parentPort.once("message", () => {
      parentPort.postMessage({ type: "stopped" });
      parentPort.close();
    });
  `)}`,
    ),
  resolveRuntimeWorkerArgv: (url: URL) => [url.href],
}));

const options: DiscordAudioWorkerOptions = {
  guildId: "guild",
  channelId: "voice",
  group: "host-floor-test",
  selfDeaf: false,
  selfMute: false,
  connectTimeoutMs: 30_000,
  reconnectGraceMs: 15_000,
  captureSilenceGraceMs: 2_000,
  realtime: true,
};

beforeEach(() => {
  host.trackedWorkerAvailable = true;
  host.createTrackedWorker.mockReset().mockImplementation((...args) => new Worker(...args));
});

it.each([true, false])(
  "runs and closes the worker with tracked factory available=%s",
  async (available) => {
    host.trackedWorkerAvailable = available;
    const worker = createDiscordAudioWorkerThread(options);
    const events: DiscordAudioEvent[] = [];
    const exited = new Promise<number>((resolve, reject) => {
      worker.on("error", reject);
      worker.once("exit", resolve);
      worker.on("message", (event) => {
        events.push(event);
        if (event.type === "log") {
          // Node Worker has no browser targetOrigin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          worker.postMessage({ type: "stop" });
        }
      });
    });
    try {
      expect(await exited).toBe(0);
      expect(events).toEqual([
        { type: "log", level: "verbose", message: JSON.stringify(options) },
        { type: "stopped" },
      ]);
      expect(host.createTrackedWorker).toHaveBeenCalledTimes(available ? 1 : 0);
    } finally {
      await worker.terminate();
    }
  },
);

it("propagates a tracked factory failure without creating an untracked worker", () => {
  const error = new Error("worker accounting refused startup");
  host.createTrackedWorker.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => createDiscordAudioWorkerThread(options)).toThrow(error);
  expect(host.createTrackedWorker).toHaveBeenCalledOnce();
});
