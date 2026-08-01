export const MATRIX_UNCLEAN_RESTART_REPLAY_MS = 24 * 60 * 60 * 1000;

export type MatrixReplayHorizonInput = {
  hasPersistedSyncState: boolean;
  hasCleanShutdownSyncState: boolean;
  startupMs: number;
  startupGraceMs: number;
};

export function resolveMatrixReplayCutoffMs(input: MatrixReplayHorizonInput): number | null {
  if (!input.hasPersistedSyncState) {
    return input.startupMs - input.startupGraceMs;
  }
  if (input.hasCleanShutdownSyncState) {
    return null;
  }
  return input.startupMs - MATRIX_UNCLEAN_RESTART_REPLAY_MS;
}
