import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixture,
  installJournalMessageWriteHook,
  createJournalSession,
  emitReplayGroup,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import { createAttemptGate } from "./attempt.test-support.js";

afterEach(() => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

async function memoryFixture() {
  const fixture = await createFixture();
  fixture.bridge.detach();
  const manager = SessionManager.inMemory(fixture.tempDir);
  const attempt = { ...fixture.attempt, sessionTarget: undefined, sessionManager: manager };
  return { ...fixture, manager, attempt, ...createJournalSession(attempt) };
}

describe("Copilot caller-owned transcript", () => {
  it.each([false, true])(
    "preserves group hooks and replay identity (blocked: %s)",
    async (blocked) => {
      const hook = vi.fn(({ message }) =>
        blocked && message.role === "toolResult" ? { block: true } : undefined,
      );
      installJournalMessageWriteHook(hook);
      const first = await memoryFixture();
      const { manager, attempt } = first;
      await first.journal.persistInitialUser();
      emitReplayGroup(first.session);
      await first.journal.barrier("first group");
      first.bridge.detach();

      const expectedRoles = blocked ? ["user"] : ["user", "assistant", "toolResult"];
      const initial = transcriptMessages(manager.getEntries());
      expect(initial.map((row) => row.message.role)).toEqual(expectedRoles);
      expect(first.journal.snapshot().replayInvalid).toBe(blocked);
      const calls = hook.mock.calls.length;

      const replay = createJournalSession(attempt);
      await replay.journal.persistInitialUser();
      emitReplayGroup(replay.session);
      await replay.journal.barrier("replayed group");
      replay.bridge.detach();

      expect(transcriptMessages(manager.getEntries())).toEqual(initial);
      if (!blocked) {
        expect(hook).toHaveBeenCalledTimes(calls);
      }
    },
  );

  it.each(["durable", "memory"] as const)(
    "rejects a manager rebound to %s while user resolution is awaited",
    async (destination) => {
      const { manager, recorder, target, attempt, journal, bridge } = await memoryFixture();
      const resolution = createAttemptGate<Extract<AgentMessage, { role: "user" }>>();
      recorder.resolveMessage.mockImplementation(resolution.wait);
      const persistence = journal.persistInitialUser();
      await resolution.entered;
      if (destination === "durable") {
        await manager.setSessionTargetAsync(target);
      } else {
        manager.newSession();
      }
      resolution.release({ role: "user", content: attempt.prompt, timestamp: 1 });

      await expect(persistence).rejects.toThrow("caller-owned transcript changed");
      bridge.detach();
      expect(transcriptMessages(manager.getEntries())).toEqual([]);
    },
  );

  it("rejects a manager reset by a tool-group hook before publishing the group", async () => {
    const { manager, journal, session, bridge } = await memoryFixture();
    installJournalMessageWriteHook((input: unknown) => {
      if ((input as { message: AgentMessage }).message.role === "assistant") {
        manager.newSession();
      }
    });
    await journal.persistInitialUser();
    emitReplayGroup(session);

    await expect(journal.barrier("rebound group")).rejects.toThrow(
      "caller-owned transcript changed",
    );
    bridge.detach();
    expect(transcriptMessages(manager.getEntries())).toEqual([]);
  });

  it("keeps the complete prefix when a tool-result serialization fails", async () => {
    installJournalMessageWriteHook((input: unknown) => {
      const message = (input as { message: AgentMessage }).message;
      return message.role === "toolResult"
        ? { message: { ...message, details: { nonSerializable: 1n } } }
        : undefined;
    });
    const { manager, journal, session, bridge } = await memoryFixture();
    const abort = vi.spyOn(session, "abort");
    await journal.persistInitialUser();
    emitReplayGroup(session);

    await expect(journal.barrier("invalid group")).rejects.toThrow("BigInt");
    bridge.detach();
    expect(transcriptMessages(manager.getEntries()).map((row) => row.message.role)).toEqual([
      "user",
    ]);
    expect(abort).toHaveBeenCalledOnce();
  });
});
