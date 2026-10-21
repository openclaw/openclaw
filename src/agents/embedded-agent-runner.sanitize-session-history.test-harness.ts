// Shared fixtures for session-history sanitization tests.
import { vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { SessionManager } from "./sessions/index.js";

type SessionEntry = { type: string; customType: string; data: unknown };
export type SanitizeSessionHistoryFn =
  typeof import("./embedded-agent-runner/replay-history.js").sanitizeSessionHistory;
export const TEST_SESSION_ID = "test-session";

export function makeModelSnapshotEntry(data: {
  timestamp?: number;
  provider: string;
  modelApi: string;
  modelId: string;
}): SessionEntry {
  return {
    type: "custom",
    customType: "model-snapshot",
    data: {
      timestamp: data.timestamp ?? Date.now(),
      provider: data.provider,
      modelApi: data.modelApi,
      modelId: data.modelId,
    },
  };
}

export function makeInMemorySessionManager(
  entries: SessionEntry[],
  activeBranchEntries: SessionEntry[] = entries,
): SessionManager {
  return {
    getSessionTarget: () => undefined,
    getEntries: vi.fn(() => entries),
    getBranch: vi.fn(() => activeBranchEntries),
    appendCustomEntryAsync: vi.fn(async (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      if (activeBranchEntries !== entries) {
        activeBranchEntries.push(entry);
      }
      return `custom-entry-${entries.length}`;
    }),
  } as unknown as SessionManager;
}

export function makeMockSessionManager(): SessionManager {
  return {
    getSessionTarget: () => undefined,
    getEntries: vi.fn().mockReturnValue([]),
    getBranch: vi.fn().mockReturnValue([]),
    appendCustomEntryAsync: vi.fn(async () => "custom-entry"),
  } as unknown as SessionManager;
}

export async function loadSanitizeSessionHistoryWithCleanMocks(): Promise<SanitizeSessionHistoryFn> {
  vi.resetModules();
  vi.resetAllMocks();
  // Reload replay-history after mocks reset so each suite sees the same module
  // graph the production runner would import.
  const mockedHelpers = await import("./embedded-agent-helpers/images.js");
  vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  const mod = await import("./embedded-agent-runner/replay-history.js");
  return mod.sanitizeSessionHistory;
}
