export function resolveMemoryWikiTimestamp(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString();
}
