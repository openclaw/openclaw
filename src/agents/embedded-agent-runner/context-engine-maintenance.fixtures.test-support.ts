import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../context-engine/types.js";

export function createBackgroundMaintenanceEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  id = "test",
): ContextEngine & { started: Promise<void> } {
  const started = createDeferred();
  return {
    started: started.promise,
    info: { id, name: "Test Engine", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain(params) {
      started.resolve();
      return maintain(params);
    },
  };
}

export const requireRecord = createRequireRecord("record", "expected-label");

export function firstMaintainParams(maintain: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  return requireRecord(maintain.mock.calls[0]?.[0], "maintain params");
}

export function expectRecordFields(
  record: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key]).toBe(value);
  }
}

export async function loadContextEngineMaintenanceModuleForTest() {
  // Import once and reset the owned singleton state between cases.
  const { runContextEngineMaintenance, waitForDeferredTurnMaintenanceForSession } =
    await import("./context-engine-maintenance.js");
  const { resetDeferredTurnMaintenanceStateForTest } =
    await import("./context-engine-maintenance.test-support.js");
  resetDeferredTurnMaintenanceStateForTest();
  return {
    runContextEngineMaintenance,
    waitForDeferredTurnMaintenanceForSession,
    resetDeferredTurnMaintenanceStateForTest,
  };
}

export function createMaintenanceSessionManagerOpenFixture() {
  let current: { getSessionTarget: () => SessionTranscriptRuntimeTarget } | undefined;
  const openAsync = vi.fn(async (target: SessionTranscriptRuntimeTarget) => {
    current = { getSessionTarget: () => target };
    return current;
  });
  return {
    openAsync,
    get current() {
      return current;
    },
    reset() {
      current = undefined;
      openAsync.mockClear();
    },
  };
}
