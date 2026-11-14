import { resolveExecutablePath } from "../infra/executable-path.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput, TerminationReason } from "../process/supervisor/types.js";

export type DurableControlOptions = Pick<SpawnInput, "env" | "assertCurrent" | "initiateSpawn">;
export type DurableStopOptions = Pick<DurableControlOptions, "assertCurrent">;
export type DurableLaunchOptions = DurableControlOptions &
  Pick<SpawnInput, "cwd" | "timeoutMs"> & {
    id: string;
    argv: string[];
    env: Record<string, string>;
    logPath: string;
  };
export type DurableProcessObservation =
  | { state: "missing" }
  | { state: "running"; pid?: number; cgroupDirectory?: string }
  | {
      state: "exited";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      reason: TerminationReason;
      result: string;
      /** Supervisor-measured run time, when the supervisor records one. */
      durationMs?: number;
      /** Explains an exit whose outcome the supervisor could not record. */
      note?: string;
    };

/**
 * One host service manager (Linux systemd user manager, macOS launchd) that keeps a
 * durable process outside the Gateway. The registry owns all bookkeeping; a supervisor
 * only launches, observes, stops and releases its retained job by identity.
 */
export type DurableProcessSupervisor = {
  unitName(id: string): string;
  requireHost(env?: NodeJS.ProcessEnv): Promise<void>;
  launch(params: DurableLaunchOptions): Promise<{ unitName: string }>;
  read(unit: string): Promise<DurableProcessObservation>;
  stop(unit: string, options?: DurableStopOptions): Promise<void>;
  /** Release the retained job; the registry records its real result first. */
  cleanup(unit: string, options?: DurableStopOptions): Promise<void>;
};
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
