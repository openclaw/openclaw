import type { ChildProcess, SpawnOptions } from "node:child_process";

export type PnpmRunnerParams = {
  pnpmArgs?: string[];
  nodeArgs?: string[];
  npmExecPath?: string;
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
  stdio?: SpawnOptions["stdio"];
  env?: NodeJS.ProcessEnv;
};

export function spawnPnpmRunner(params?: PnpmRunnerParams): ChildProcess;
