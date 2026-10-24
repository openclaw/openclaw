export type InstalledRecoveryCommandState =
  | { state: "running" }
  | { state: "rejected"; error: string }
  | { state: "completed"; status: number; treeJoined: true };
export function runInstalledRecoveryCommand(options: {
  stdout: string;
  stderr: string;
  record: (state: InstalledRecoveryCommandState) => void;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  timeoutKillGraceMs: number;
}): Promise<{ status: number; stdout: string; stderr: string }>;
