import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

type ContextEngineAttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];

export function useContextEngineAttemptHarness(sessionKey: string) {
  const hoisted = getHoisted();
  const tempPaths: string[] = [];
  const suiteTempPaths: string[] = [];
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });
  afterEach(() => {
    suiteTempPaths.push(...tempPaths.splice(0));
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await cleanupTempPaths(suiteTempPaths);
  });
  beforeAll(preloadRunEmbeddedAttemptForTests);
  const runAttempt = (options: Partial<Omit<ContextEngineAttemptOptions, "tempPaths">> = {}) =>
    createContextEngineAttemptRunner({
      sessionKey,
      tempPaths,
      contextEngine: createContextEngineBootstrapAndAssemble(),
      ...options,
    });
  return { hoisted, tempPaths, runAttempt };
}
