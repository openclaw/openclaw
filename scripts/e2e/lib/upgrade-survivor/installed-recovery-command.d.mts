export type InstalledRecoveryCommandState = { startedAt: number; elapsedMs: number } & (
  | { state: "running" }
  | { state: "rejected"; error: string }
  | { state: "completed"; status: number; treeJoined: true }
);
export function runInstalledRecoveryCommand(options: {
  stdout: string;
  stderr: string;
  record: (state: InstalledRecoveryCommandState) => void;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: string;
  timeoutKillGraceMs: number;
}): Promise<{ status: number; stdout: string; stderr: string }>;
