// Shared fixtures for session-history sanitization tests.
import { vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { AgentMessage } from "./runtime/index.js";
import type { SessionManager } from "./sessions/index.js";

type SessionEntry = { type: string; customType: string; data: unknown };
export type SanitizeSessionHistoryFn =
  typeof import("./embedded-agent-runner/replay-history.js").sanitizeSessionHistory;
type SanitizeSessionHistoryMockedHelpers = typeof import("./embedded-agent-helpers.js");
export type SanitizeSessionHistoryHarness = {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  mockedHelpers: SanitizeSessionHistoryMockedHelpers;
};
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
  const appendCustomEntry = vi.fn((customType: string, data: unknown) => {
    const entry = { type: "custom", customType, data };
    entries.push(entry);
    if (activeBranchEntries !== entries) {
      activeBranchEntries.push(entry);
    }
  });
  return {
    getEntries: vi.fn(() => entries),
    getBranch: vi.fn(() => activeBranchEntries),
    appendCustomEntry,
    appendCustomEntryAsync: async (customType: string, data: unknown) =>
      appendCustomEntry(customType, data),
  } as unknown as SessionManager;
}

export function makeMockSessionManager(): SessionManager {
  return {
    getEntries: vi.fn().mockReturnValue([]),
    getBranch: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
    appendCustomEntryAsync: vi.fn(async () => {}),
  } as unknown as SessionManager;
}

export async function createSanitizeSessionHistoryHelpersMock(extra: Record<string, unknown> = {}) {
  return {
    ...(await vi.importActual("./embedded-agent-helpers.js")),
    sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
    ...extra,
  };
}

export async function createSanitizeSessionHistoryProviderRuntimeMock(
  extra: Record<string, unknown> = {},
) {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    // Default to no provider plugin participation; individual tests opt in to
    // hooks so ownership boundaries stay explicit.
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    sanitizeProviderReplayHistoryWithPlugin: vi.fn(() => undefined),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
    ...extra,
  };
}

export async function createSanitizeSessionHistoryProviderHookRuntimeMock(
  extra: Record<string, unknown> = {},
) {
  const clearProviderRuntimePluginCacheForTest = vi.fn();
  const actual = await vi.importActual<typeof import("../plugins/provider-hook-runtime.js")>(
    "../plugins/provider-hook-runtime.js",
  );
  return {
    ...actual,
    clearProviderRuntimePluginCacheForTest,
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    prepareProviderExtraParams: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
    testing: { clearProviderRuntimePluginCacheForTest },
    ...extra,
  };
}

export async function loadSanitizeSessionHistoryWithCleanMocks(): Promise<SanitizeSessionHistoryHarness> {
  vi.resetModules();
  vi.resetAllMocks();
  // Reload replay-history after mocks reset so each suite sees the same module
  // graph the production runner would import.
  const mockedHelpers = await import("./embedded-agent-helpers.js");
  vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  const mod = await import("./embedded-agent-runner/replay-history.js");
  return {
    sanitizeSessionHistory: mod.sanitizeSessionHistory,
    mockedHelpers,
  };
}

export function makeReasoningAssistantMessages(opts?: {
  thinkingSignature?: "object" | "json";
  includeText?: boolean;
  timestamp?: number;
}): AgentMessage[] {
  const thinkingSignature: unknown =
    opts?.thinkingSignature === "json"
      ? JSON.stringify({ id: "rs_test", type: "reasoning" })
      : { id: "rs_test", type: "reasoning" };
  const content: Array<Record<string, unknown>> = [
    {
      type: "thinking",
      thinking: "reasoning",
      thinkingSignature,
    },
  ];
  if (opts?.includeText) {
    content.push({ type: "text", text: "answer" });
  }

  // Intentional: we want to build message payloads that can carry non-string
  // signatures, but core typing currently expects a string.
  const messages = [
    {
      role: "assistant",
      content,
      ...(opts?.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
    },
  ];

  return messages as unknown as AgentMessage[];
}
