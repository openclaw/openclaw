import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux").each([
  [undefined, 1],
  ["RAYON_NUM_THREADS", 2],
  ["RAYON_RS_NUM_CPUS", 2],
] as const)(
  "bounds the native DAVE pool after Worker exit with inherited limit %s",
  async (inherited, retainedThreads) => {
    const url = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "audio-native-pool.test-support",
      distWorkerPath: "extensions/discord/src/voice/audio-native-pool.test-support.js",
    });
    const env = { ...process.env };
    delete env.RAYON_NUM_THREADS;
    delete env.RAYON_RS_NUM_CPUS;
    if (inherited) {
      env[inherited] = "2";
    }
    const { stdout } = await promisify(execFile)(process.execPath, resolveRuntimeWorkerArgv(url), {
      env,
    });
    expect(JSON.parse(stdout)).toEqual({ retainedThreads });
  },
);
