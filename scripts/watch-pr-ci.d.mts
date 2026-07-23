export interface WatchPrCiArgs {
  pr: number;
  headSha: string;
  repo: string;
  attachTimeout: number;
  timeout: number;
  interval: number;
}

export interface RollupCheck {
  kind: "CheckRun" | "StatusContext";
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

export interface RollupPayload {
  state?: string;
  contexts?: { nodes?: RollupCheck[] };
}

export interface RollupClassification {
  verdict: "GREEN" | "FAILING" | "PENDING" | "STALE-CANCELLED";
  pendingCount: number;
  failingNames: string[];
}

export function parseArgs(argv: string[]): WatchPrCiArgs;
export function classifyRollup(rollup: RollupPayload | null | undefined): RollupClassification;
export function buildFindRunArgs(repo: string, sha: string): string[];
