import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

export async function cleanupTrackedSessionState(dirs: Iterable<string>, cleanup: () => void) {
  for (const stateDir of dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  cleanup();
}
