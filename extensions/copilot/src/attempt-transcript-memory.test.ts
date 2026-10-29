import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixture,
  createJournalSession,
  emitReplayGroup,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

afterEach(() => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

describe("Copilot caller-owned transcript", () => {
  it("persists an ephemeral setup turn in its in-memory manager", async () => {
    const fixture = await createFixture();
    fixture.bridge.detach();
    const manager = SessionManager.inMemory(fixture.tempDir);
    const attempt = { ...fixture.attempt, sessionTarget: undefined, sessionManager: manager };
    const first = createJournalSession(attempt);

    await first.journal.persistInitialUser();
    emitReplayGroup(first.session);
    await first.journal.barrier("first group");
    first.bridge.detach();

    expect(transcriptMessages(manager.getEntries()).map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });
});
