import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { expect, it } from "vitest";
import { discordAudioTestEntrypoints } from "./audio-worker-entrypoints.test-support.js";

it.skipIf(process.platform !== "linux").each([
  [undefined, 1, true],
  ["RAYON_NUM_THREADS", 2, true],
  ["RAYON_RS_NUM_CPUS", 2, true],
  [undefined, 0, false],
] as const)(
  "retains %s override and %i native threads with DAVE enabled=%s",
  async (inherited, retainedThreads, daveEncryption) => {
    const url = resolveRuntimeWorkerUrl(discordAudioTestEntrypoints.nativePool);
    const env = { ...process.env };
    delete env.RAYON_NUM_THREADS;
    delete env.RAYON_RS_NUM_CPUS;
    if (inherited) {
      env[inherited] = "2";
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...resolveRuntimeWorkerArgv(url), String(daveEncryption)],
      { env },
    );
    const childEnv = inherited
      ? { [inherited]: "2" }
      : daveEncryption
        ? { RAYON_NUM_THREADS: "1" }
        : {};
    expect(JSON.parse(stdout)).toEqual({
      retainedThreads,
      directEnv: childEnv,
    });
  },
);
