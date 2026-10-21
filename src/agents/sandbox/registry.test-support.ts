import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";

export function useSandboxRegistryState(prefix: string, dispose = () => {}) {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      dispose();
      vi.restoreAllMocks();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeStateDatabaseForTest();
      clearRuntimeConfigSnapshot();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );
  const state = { root: "", make: dirs.make };
  beforeEach(() => {
    state.root = dirs.make(prefix);
    vi.stubEnv("OPENCLAW_STATE_DIR", state.root);
  });
  return state;
}
