import type { FrvConcreteClient } from "./frv.mjs";
export function cancelReleaseTree(
  runId: string,
  client: FrvConcreteClient,
  options?: { dryRun?: boolean; force?: boolean },
): Promise<{
  action: string;
  complete: boolean;
  cancellation: { key: string; runId: string; runAttempt: number; state: string }[];
  activeRunIds: string[];
  excludedRunIds: string[];
  failures: string[];
  nextCommand: string;
}>;
