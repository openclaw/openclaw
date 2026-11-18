import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { vi } from "vitest";

// In-memory session fixture; receipt publication itself is covered by the
// session-entry-current-check owner's native/worker integration tests.
// mock-isolation: retain the fixture's in-memory sessions without opening a real session database.
vi.mock("./session-authority.js", () => ({
  prepareDiscussionSessionEntry: async (runtime: PluginRuntime, sessionKey: string) => {
    const entry = await runtime.agent.session.getSessionEntryAsync({ sessionKey });
    const sessionId = entry?.sessionId;
    const archivedAt = entry?.archivedAt;
    return {
      entry,
      source() {
        const current = runtime.agent.session.getSessionEntry({ sessionKey });
        if (current?.sessionId !== sessionId || current?.archivedAt !== archivedAt) {
          throw new Error("The selected session changed before its operation committed.");
        }
      },
      release() {},
    };
  },
}));
