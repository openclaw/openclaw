import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { peekSystemEvents } from "../../infra/system-events.js";
import { createQueuedTaskRunCore as createQueuedTaskRunOrNull } from "../../tasks/task-executor.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";

export function createQueuedTaskRunCore(
  params: Parameters<typeof createQueuedTaskRunOrNull>[0],
): TaskRecord {
  // Task creation can legally return null for invalid inputs; tests here always
  // need a concrete queued task record.
  const task = createQueuedTaskRunOrNull(params);
  if (!task) {
    throw new Error("expected queued task creation to succeed");
  }
  return task;
}
export function createBackgroundMaintenanceEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  id = "test",
): ContextEngine {
  return {
    info: { id, name: "Test Engine", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
  };
}

export async function flushAsyncWork(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

export async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 2_000,
  stepMs = 5,
): Promise<void> {
  // Timed polling lets fake-timer tasks advance through queue and delivery
  // microtasks without binding assertions to a specific internal await count.
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await vi.advanceTimersByTimeAsync(stepMs);
      await flushAsyncWork();
    }
  }
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

export function expectSystemEventContaining(sessionKey: string, text: string) {
  expect(peekSystemEvents(sessionKey).join("\n")).toContain(text);
}
