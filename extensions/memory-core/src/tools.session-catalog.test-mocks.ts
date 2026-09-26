import { vi } from "vitest";

const sessionStore = vi.hoisted(() => ({
  "agent:main:main": {
    sessionId: "thread-1",
    updatedAt: 2,
    sessionFile: "/tmp/sessions/thread-1.jsonl",
    chatType: "direct" as const,
  },
  "agent:main:webchat:direct:owner": {
    sessionId: "past-thread",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/past-thread.jsonl",
    chatType: "direct" as const,
  },
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  return {
    ...actual,
    loadArchivedSessions: vi.fn(() => []),
  };
});

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: sessionStore,
    })),
  };
});
