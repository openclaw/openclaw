export function isToolStartOrUpdatePhase(phase: unknown): boolean {
  return phase === "start" || phase === "update";
}

export function isCompactionEndWithoutRetry(phase: unknown, willRetry: unknown): boolean {
  return phase === "end" && willRetry !== true;
}
