/** The structural schemas admit these fields before applying their cross-field checks. */
export function hasValidNodeHostResources(stats: {
  memoryFreeBytes: number;
  memoryTotalBytes: number;
  diskTotalBytes?: number;
  diskAvailableBytes?: number;
}): boolean {
  return (
    stats.memoryFreeBytes <= stats.memoryTotalBytes &&
    (stats.diskTotalBytes === undefined
      ? stats.diskAvailableBytes === undefined
      : stats.diskAvailableBytes !== undefined && stats.diskAvailableBytes <= stats.diskTotalBytes)
  );
}

export function hasValidSessionExecAction(value: {
  action?: string;
  argv?: readonly unknown[];
  processId?: string;
  input?: string;
  timeoutMs?: number;
}): boolean {
  const action = value.action ?? "run";
  return action === "run"
    ? value.argv !== undefined && value.processId === undefined
    : action === "start"
      ? value.argv !== undefined && value.processId !== undefined
      : value.processId !== undefined &&
        value.argv === undefined &&
        value.input === undefined &&
        value.timeoutMs === undefined;
}
