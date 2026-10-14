// Qa Lab plugin module implements process wait helper behavior.
import { setTimeout as sleep } from "node:timers/promises";

const POLL_INTERVAL_MS = 10;
// Generous ceiling for loaded CI runners: callers synchronize on the asserted
// state, so a large bound only delays failure reporting, never success.
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForDead(pid: number, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for pid ${pid} to exit`);
}
