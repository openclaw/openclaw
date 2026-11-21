export type PreparedModelRuntimeStartupStatus = Readonly<{
  degraded: boolean;
  pendingAgents: readonly string[];
  stage?: string;
}>;

let startupStatus: PreparedModelRuntimeStartupStatus | undefined;

/** Diagnostic projection of the publication owner; reads never start acquisition. */
export function getPreparedModelRuntimeStartupStatus():
  | PreparedModelRuntimeStartupStatus
  | undefined {
  return startupStatus;
}

export function setPreparedModelRuntimeStartupStatus(
  value: PreparedModelRuntimeStartupStatus | undefined,
): void {
  startupStatus = value;
}
