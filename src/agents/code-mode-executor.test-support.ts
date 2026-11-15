export function createCodeModeExecutorConfig(timeoutMs = 1_000) {
  return {
    timeoutMs,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputBytes: 65_536,
    maxSnapshotBytes: 10 * 1024 * 1024,
    maxPendingToolCalls: 16,
  };
}
