import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";

export function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    permissionMode: "guarded",
    updatedAt: Date.now() - 10_000,
    status: "running",
    abortedLastRun: true,
    ...overrides,
  });
}

export function runningSessionEntry(
  sessionId: string,
  overrides: SessionEntryFixture = {},
): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}
