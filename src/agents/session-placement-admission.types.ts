export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

/** Shared admission operation; request contracts must not import the agent runtime. */
export type RequiredSessionPlacementAdmission = <T>(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
  task: (assertPlacementCurrent: () => void) => Promise<T>,
  assertCurrent?: () => void,
  signal?: AbortSignal,
  preparation?: { waitForReady: false },
) => Promise<T>;
