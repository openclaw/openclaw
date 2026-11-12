import { resolveExecutablePath } from "../infra/executable-path.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";

export type DurableControlOptions = Pick<SpawnInput, "env" | "assertCurrent" | "initiateSpawn">;
const MAX_OUTPUT = 256_000;

/** Run one service-manager CLI call through the Gateway's process supervisor and spawn broker. */
export async function runDurableControlCommand(
  argv: string[],
  options: DurableControlOptions,
  failure: () => Error,
): Promise<RunExit> {
  try {
    const executable = resolveExecutablePath(argv[0]!, { env: process.env, cwd: process.cwd() });
    if (!executable) {
      throw failure();
    }
    const run = await getProcessSupervisor().spawn({
      mode: "child",
      argv: [executable, ...argv.slice(1)],
      env: process.env,
      exactEnv: true,
      cleanupOwnership: "external",
      stdinMode: "pipe-closed",
      timeoutMs: 15_000,
      maxCapturedOutputChars: MAX_OUTPUT,
      ...options,
    });
    const result = await run.wait();
    if (result.reason !== "exit" || result.stdout.length >= MAX_OUTPUT) {
      throw failure();
    }
    return result;
  } catch {
    throw failure();
  }
}
