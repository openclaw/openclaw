import type { InternalSessionEntry as SessionEntry } from "../config/sessions/main-session-recovery.types.js";

type MainRecoveryStateFields = Pick<
  SessionEntry,
  "abortedLastRun" | "restartRecoveryRuns" | "mainRestartRecovery"
>;

export function buildMainSessionRecoveryClearPatch(
  entry?: Partial<MainRecoveryStateFields> | null,
): Partial<MainRecoveryStateFields> {
  if (
    entry?.abortedLastRun !== true &&
    entry?.restartRecoveryRuns === undefined &&
    entry?.mainRestartRecovery === undefined
  ) {
    return {};
  }
  return {
    abortedLastRun: false,
    restartRecoveryRuns: undefined,
    mainRestartRecovery: undefined,
  };
}

export function clearMainSessionRecoveryAfterAgentRun(
  entry: SessionEntry,
  clearForceSafeTools: boolean | undefined,
): void {
  const aborted = entry.abortedLastRun === true;
  if (clearForceSafeTools && !aborted) {
    entry.restartRecoveryForceSafeTools = undefined;
  }
  if (!aborted) {
    Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
  }
}

export type { MainRecoveryStateFields };
