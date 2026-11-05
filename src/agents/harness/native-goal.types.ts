/** A provider-native pursuit borrows one admitted host run; this is not a scheduler. */
export type AgentHarnessNativeGoal = Readonly<{
  version: 1;
  id: string;
  objective: string;
  tokenBudget?: number;
  /** Revoked by host goal edits or the lending run ending, not by usage accounting. */
  signal: AbortSignal;
  /** Revalidate before starting or continuing native execution. */
  assertCurrent(): void;
  /** Own real Goal-tool verdict, retained only through this execution's final settlement. */
  readToolStatus?(): "complete" | "blocked" | undefined;
  /** Project observed native state, never infer completion from a successful model turn. */
  onStatus(update: {
    status: "active" | "paused" | "blocked" | "complete";
    reason?: string;
  }): Promise<void>;
}>;
