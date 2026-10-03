import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
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
  it.each([false, true])(
    "preserves group hooks and replay identity (blocked: %s)",
    async (blocked) => {
      const hook = vi.fn(({ message }) =>
        blocked && message.role === "toolResult" ? { block: true } : undefined,
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const fixture = await createFixture();
      fixture.bridge.detach();
      const manager = SessionManager.inMemory(fixture.tempDir);
      const attempt = { ...fixture.attempt, sessionTarget: undefined, sessionManager: manager };
      const first = createJournalSession(attempt);
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
      const fixture = await createFixture();
      fixture.bridge.detach();
      const manager = SessionManager.inMemory(fixture.tempDir);
      const resolved = createDeferred<Extract<AgentMessage, { role: "user" }>>();
      const started = createDeferred<void>();
      fixture.recorder.resolveMessage.mockImplementation(async () => {
        started.resolve();
        return await resolved.promise;
      });
      const { journal, bridge } = createJournalSession({
        ...fixture.attempt,
        sessionTarget: undefined,
        sessionManager: manager,
      });
      const persistence = journal.persistInitialUser();
      await started.promise;
      if (destination === "durable") {
        await manager.setSessionTargetAsync(fixture.target);
      } else {
        manager.newSession();
      }
      resolved.resolve({ role: "user", content: fixture.attempt.prompt, timestamp: 1 });

      await expect(persistence).rejects.toThrow("caller-owned transcript changed");
      bridge.detach();
      expect(transcriptMessages(manager.getEntries())).toEqual([]);
    },
  );

  it("rejects a manager reset by a tool-group hook before publishing the group", async () => {
    const fixture = await createFixture();
    fixture.bridge.detach();
    const manager = SessionManager.inMemory(fixture.tempDir);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            if ((input as { message: AgentMessage }).message.role === "assistant") {
              manager.newSession();
            }
          },
        },
      ]),
    );
    const { journal, session, bridge } = createJournalSession({
      ...fixture.attempt,
      sessionTarget: undefined,
      sessionManager: manager,
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            return message.role === "toolResult"
              ? { message: { ...message, details: { nonSerializable: 1n } } }
              : undefined;
          },
        },
      ]),
    );
    const fixture = await createFixture();
    fixture.bridge.detach();
    const manager = SessionManager.inMemory(fixture.tempDir);
    const { journal, session, bridge } = createJournalSession({
      ...fixture.attempt,
      sessionTarget: undefined,
      sessionManager: manager,
    });
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
