import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import workerThreads, { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";

if (isMainThread) {
  // Redirect only the media payload: exercise the real parent launch owner, then
  // real native MLS work without opening a Discord socket or loading credentials.
  const NativeWorker = workerThreads.Worker;
  Object.defineProperty(workerThreads, "Worker", {
    value: class extends NativeWorker {
      constructor(url: string | URL, options?: workerThreads.WorkerOptions) {
        assert.ok(String(url).includes("audio-worker.runtime"));
        super(new URL(import.meta.url), options);
      }
    },
  });
  syncBuiltinESMExports();
  const { createDiscordAudioWorkerThread } = await import("./audio-worker-thread.js");
  const before = readdirSync("/proc/self/task").length;
  const worker = createDiscordAudioWorkerThread({
    guildId: "1",
    channelId: "1000",
    group: "native-pool-test",
    selfDeaf: false,
    selfMute: false,
    connectTimeoutMs: 30_000,
    reconnectGraceMs: 15_000,
    captureSilenceGraceMs: 2_000,
    realtime: true,
    // Exercise default-enabled voice unless the test explicitly disables DAVE.
    daveEncryption: process.argv[2] === "false" ? false : undefined,
  } satisfies DiscordAudioWorkerOptions);
  let completed = false;
  worker.on("message", () => {
    completed = true;
  });
  try {
    // The actual object is a Node Worker; the launch interface deliberately
    // exposes only its transport events, so join through that interface.
    await new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Native fixture exited with ${code}`));
        }
      });
    });
    assert.ok(completed);
    const retainedThreads = readdirSync("/proc/self/task").length - before;
    const childCode =
      "console.log(JSON.stringify({RAYON_NUM_THREADS:process.env.RAYON_NUM_THREADS,RAYON_RS_NUM_CPUS:process.env.RAYON_RS_NUM_CPUS}))";
    const directEnv = JSON.parse(
      execFileSync(process.execPath, ["-e", childCode], { encoding: "utf8" }),
    );
    console.log(JSON.stringify({ retainedThreads, directEnv }));
  } finally {
    await worker.terminate();
  }
} else {
  const options: DiscordAudioWorkerOptions = workerData;
  if (options.daveEncryption !== false) {
    const { exerciseDaveRekey } = await import("./dave-native-pool.test-support.js");
    exerciseDaveRekey();
  }
  assert.ok(parentPort);
  // Node Worker has no browser targetOrigin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort.postMessage({ type: "stopped" });
  parentPort.close();
}
