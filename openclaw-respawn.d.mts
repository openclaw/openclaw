import type { ChildProcess, spawn as defaultSpawn } from "node:child_process";

export const respawnSignals: NodeJS.Signals[];
export const respawnSignalExitGraceMs: number;
export const respawnSignalForceKillGraceMs: number;

export type RunRespawnedChildOptions = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof defaultSpawn;
  exit?: (code?: number) => never;
  writeError?: (message: string) => void;
  errorMessage?: string;
  platform?: NodeJS.Platform;
  signals?: NodeJS.Signals[];
  signalExitGraceMs?: number;
  signalForceKillGraceMs?: number;
};

export function runRespawnedChild(options: RunRespawnedChildOptions): ChildProcess;
