import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { admitCompletionFixtureDatabase } from "./subagent-completion-admission.test-helpers.js";

export function useCompletionDatabase(prefix: string, closed?: () => void) {
  let database: OpenClawStateDatabase;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make(prefix, resolvePreferredOpenClawTmpDir()));
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closed?.();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });
  return {
    get value() {
      return database;
    },
    set value(opened: OpenClawStateDatabase) {
      database = opened;
    },
  };
}
