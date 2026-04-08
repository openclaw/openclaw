export type MatrixSyncState =
  | "PREPARED"
  | "SYNCING"
  | "CATCHUP"
  | "RECONNECTING"
  | "ERROR"
  | "STOPPED"
  | (string & {});

export function isMatrixReadySyncState(
  state: MatrixSyncState | null | undefined,
): state is "PREPARED" | "SYNCING" | "CATCHUP" {
  return state === "PREPARED" || state === "SYNCING" || state === "CATCHUP";
}

export function isMatrixDisconnectedSyncState(
  state: MatrixSyncState | null | undefined,
): state is "RECONNECTING" | "ERROR" | "STOPPED" {
  return state === "RECONNECTING" || state === "ERROR" || state === "STOPPED";
}

export function isMatrixTerminalSyncState(
  state: MatrixSyncState | null | undefined,
): state is "ERROR" | "STOPPED" {
  return state === "ERROR" || state === "STOPPED";
}
