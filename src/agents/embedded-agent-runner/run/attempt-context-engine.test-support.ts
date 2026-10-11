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

export type ContextEngineAttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];

export function completedStream(message: unknown) {
  return { result: async () => message, [Symbol.asyncIterator]: () => (async function* () {})() };
}

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
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });
  return {
    hoisted,
    tempPaths,
    runAttempt: (
      options: Omit<ContextEngineAttemptOptions, "sessionKey" | "tempPaths" | "contextEngine"> &
        Partial<Pick<ContextEngineAttemptOptions, "contextEngine" | "sessionKey">> = {},
    ) =>
      createContextEngineAttemptRunner({
        sessionKey,
        tempPaths,
        contextEngine: createContextEngineBootstrapAndAssemble(),
        ...options,
      }),
  };
}
