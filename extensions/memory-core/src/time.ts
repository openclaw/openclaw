export function resolveMemoryCoreNowMs(nowMs?: number): number {
  const candidate = nowMs ?? Number.NaN;
  return new Date(candidate).toJSON() === null ? Date.now() : candidate;
}

export function resolveMemoryCoreTimestamp(nowMs?: number): string {
  return new Date(resolveMemoryCoreNowMs(nowMs)).toISOString();
}
