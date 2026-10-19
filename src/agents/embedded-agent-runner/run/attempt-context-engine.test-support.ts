import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
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

export const contextEngineInfo = {
  id: "test-context-engine",
  name: "Test Context Engine",
  version: "0.0.1",
};

export function createTestContextEngine(params: Partial<ContextEngine>): ContextEngine {
  return {
    info: { ...contextEngineInfo },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as ContextEngine;
}

export type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

export const requireRecord = createRequireRecord("object", "expected-label");

export function requireRecords(value: unknown, label: string): Array<Record<string, unknown>> {
  expect(value, label).toBeInstanceOf(Array);
  return value as Array<Record<string, unknown>>;
}

export function findRecord(
  records: Array<Record<string, unknown>>,
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
) {
  const record = records.find(predicate);
  if (!record) {
    throw new Error(`expected record: ${label}`);
  }
  return record;
}

export function runtimeContextMessage(messages: unknown) {
  return findRecord(
    requireRecords(messages, "seen messages"),
    (message) => message.customType === "openclaw.runtime-context",
    "runtime context message",
  );
}

export function mockParams(source: MockCallSource) {
  return requireRecord(source.mock.calls[0]?.[0], "mock params");
}

export function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

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
