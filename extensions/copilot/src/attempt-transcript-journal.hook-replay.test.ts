import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  createJournalSession,
  emitReplayGroup,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

afterEach(async () => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  await cleanupAttemptTranscriptJournalFixtures();
});

describe("Copilot attempt transcript journal hooks and replay", () => {
  it("marks a hook-suppressed standalone assistant replay-incomplete", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) =>
            (input as { message: AgentMessage }).message.role === "assistant"
              ? { block: true }
              : undefined,
        },
      ]),
    );
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "blocked-assistant", {
        content: "provider-visible response",
        messageId: "blocked-assistant",
      }),
    );
    await journal.barrier("blocked assistant");

    expect(journal.snapshot().replayInvalid).toBe(true);
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).map((row) => row.message.role),
    ).toEqual(["user"]);
  });

  it("marks replay incomplete when a hook rewrites provider-visible assistant content", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            if (message.role !== "assistant") {
              return undefined;
            }
            const first = message.content[0];
            if (first?.type === "text") {
              first.text = "redacted";
            }
            return { message };
          },
        },
      ]),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "rewritten-content", {
        content: "provider-visible response",
        messageId: "rewritten-content",
      }),
    );
    await journal.barrier("rewritten content");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("keeps replay valid for semantically equal hook payloads with reordered keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            if (message.role !== "assistant") {
              return undefined;
            }
            return {
              message: {
                ...message,
                content: message.content.map((part) =>
                  part.type === "text" ? { type: "text" as const, text: part.text } : part,
                ),
              },
            };
          },
        },
      ]),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "same-content", {
        content: "same",
        messageId: "same-content",
      }),
    );
    await journal.barrier("same semantic content");

    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it("rejects structurally destructive singleton hook replacements", async () => {
    for (const replacement of [
      { role: "user", content: "changed role", timestamp: 2 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "injected", name: "read", arguments: {} }],
        provider: "github-copilot",
        model: "gpt-5",
        stopReason: "toolUse",
        timestamp: 2,
      } as AgentMessage,
    ]) {
      resetGlobalHookRunner();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (input: unknown) => {
              const message = (input as { message: AgentMessage }).message;
              if (message.role !== "assistant") {
                return undefined;
              }
              Object.assign(message, replacement);
              return { message };
            },
          },
        ]),
      );
      const { journal, session, target } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect" }));
      session.emit(
        event("assistant.message", "rewritten-assistant", {
          content: "provider-visible response",
          messageId: "rewritten-assistant",
        }),
      );
      await journal.barrier("rewritten assistant");

      expect(journal.snapshot().replayInvalid).toBe(true);
      expect(
        transcriptMessages(await readSessionTranscriptEvents(target)).map(
          (row) => row.message.role,
        ),
      ).toEqual(["user"]);
    }
  });

  it("suppresses the complete group when one message is authoritatively blocked", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) =>
            (input as { message: AgentMessage }).message.role === "toolResult"
              ? { block: true }
              : undefined,
        },
      ]),
    );
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-blocked", {
        content: "checking",
        messageId: "assistant-blocked",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-blocked" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "result-blocked", {
        result: { content: "secret" },
        success: true,
        toolCallId: "call-blocked",
      }),
    );
    await journal.barrier("blocked group");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user"]);
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      replayInvalid: true,
    });
  });

  it.each(["unchanged", "assistant-text", "result-text", "tool-argument"] as const)(
    "preserves cold replay rows and detects %s drift without rerunning hooks",
    async (drift) => {
      const hook = vi.fn((input: unknown) => {
        const message = (input as { message: AgentMessage }).message;
        if (message.role === "assistant") {
          for (const part of message.content) {
            if (drift === "assistant-text" && part.type === "text") {
              part.text = "rewritten assistant";
            }
            if (drift === "tool-argument" && part.type === "toolCall") {
              part.arguments = { path: "rewritten" };
            }
          }
        }
        if (drift === "result-text" && message.role === "toolResult") {
          message.content = [{ type: "text", text: "rewritten result" }];
        }
        return { message };
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
      );
      const { attempt, bridge, journal, session, target } = await createFixture();
      await journal.persistInitialUser();
      emitReplayGroup(session);
      await journal.barrier("first commit");
      expect(hook).toHaveBeenCalledTimes(3);
      expect(journal.snapshot().replayInvalid).toBe(drift !== "unchanged");
      const firstAnchor = journal.snapshot().terminalAnchor;
      expect(firstAnchor).toBeDefined();
      bridge.detach();

      const storedEvents = await readSessionTranscriptEvents(target);
      const storedEntries = await readVisibleSessionTranscriptMessageEntries(target);
      const existingMessages = transcriptMessages(storedEvents).map((row) => row.message);
      expect(existingMessages).toHaveLength(3);
      const {
        session: replaySession,
        journal: replayJournal,
        bridge: replayBridge,
      } = createJournalSession(attempt, existingMessages);
      expect(replaySession).not.toBe(session);
      await replayJournal.persistInitialUser();
      emitReplayGroup(replaySession);
      if (drift === "unchanged") {
        await replayJournal.barrier("cold replay");
        expect(replayJournal.snapshot().terminalAnchor).toEqual(firstAnchor);
      } else {
        // Ordinary group replay must retain the accessor's strict identity check.
        // A hook-written payload mismatch is invalid replay, not a fresh write.
        await expect(replayJournal.barrier("cold replay")).rejects.toMatchObject({
          code: "transcript_persistence_failed",
          cause: { name: "TranscriptTurnAdmissionConflictError" },
        });
      }

      expect(hook).toHaveBeenCalledTimes(3);
      expect(replayJournal.snapshot()).toMatchObject({
        messagesSnapshot: existingMessages,
        replayInvalid: drift !== "unchanged",
      });
      expect(await readSessionTranscriptEvents(target)).toEqual(storedEvents);
      expect(await readVisibleSessionTranscriptMessageEntries(target)).toEqual(storedEntries);
      replayBridge.detach();
    },
  );
});
