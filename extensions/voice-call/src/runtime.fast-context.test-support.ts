// Registers a selected memory provider so realtime fast-context tests reach the
// host's real provider acquisition instead of a mocked lookup.
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

export function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  return {
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    prepareSessionEntryPatch: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        prepare,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        prepare: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await prepare(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  };
}

export function registerFastContextMemoryProvider() {
  const search = vi.fn(async () => ({
    hits: [{ reference: { providerId: "records", id: "lights" }, excerpt: "Lights are on." }],
  }));
  const open = vi.fn(async () => ({
    provider: {
      capabilities: {
        sources: ["memory" as const],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      search,
      get: async () => ({ status: "not_found" as const }),
      health: async () => ({ status: "ready" as const }),
      close: async () => {},
    },
  }));
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "records",
    capability: { providerRuntime: { open } },
  });
  setActivePluginRegistry(registry);
  return { open, search };
}
