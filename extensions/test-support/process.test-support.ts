// Preserve raw signal-0 semantics: retained zombies count, and any probe error returns false.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
