import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupAttemptTranscriptJournalFixtures();
});

describe("Copilot provider transcript durability", () => {
  it("commits provider results atomically in assistant request order", async () => {
    const { journal, session, target } = await createFixture(undefined, undefined, true);
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-provider-tools", {
        content: "checking",
        messageId: "assistant-provider-tools",
        toolRequests: [
          { arguments: { path: "a" }, name: "read", toolCallId: "call-a" },
          { arguments: { path: "b" }, name: "read", toolCallId: "call-b" },
        ],
      }),
    );
    const first = journal.recordProviderToolResult({
      providerResult: { resultType: "success", textResultForLlm: "A" },
      message: {
        role: "toolResult",
        toolCallId: "call-a",
        toolName: "read",
        content: [{ type: "text", text: "A" }],
        isError: false,
        timestamp: 3,
      },
    });
    const second = journal.recordProviderToolResult({
      providerResult: { resultType: "success", textResultForLlm: "B" },
      message: {
        role: "toolResult",
        toolCallId: "call-b",
        toolName: "read",
        content: [{ type: "text", text: "B" }],
        isError: false,
        timestamp: 4,
      },
    });

    await Promise.all([first, second]);
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).flatMap((row) =>
        row.message.role === "toolResult" ? [row.message.toolCallId] : [],
      ),
    ).toEqual(["call-a", "call-b"]);
  });

  it("stores only the sanitized provider result while fingerprinting the raw result", async () => {
    const { journal, session, target } = await createFixture(undefined, undefined, true);
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-secret", {
        content: "checking",
        messageId: "assistant-secret",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-secret" }],
      }),
    );
    await journal.recordProviderToolResult({
      providerResult: {
        resultType: "success",
        sessionLog: "raw-provider-secret",
        textResultForLlm: "safe result",
      },
      message: {
        role: "toolResult",
        toolCallId: "call-secret",
        toolName: "read",
        content: [{ type: "text", text: "safe result" }],
        isError: false,
        timestamp: 3,
      },
    });

    const persisted = JSON.stringify(await readSessionTranscriptEvents(target));
    expect(persisted).toContain("safe result");
    expect(persisted).not.toContain("raw-provider-secret");
    expect(persisted).toMatch(/providerSourceFingerprint.*sha256:[a-f0-9]{64}/u);
  });

  it("rejects provider persistence after the host authority closes", async () => {
    const { closeHost, journal, session } = await createFixture(undefined, undefined, true);
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-stale", {
        content: "checking",
        messageId: "assistant-stale",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-stale" }],
      }),
    );
    closeHost();

    await expect(
      journal.recordProviderToolResult({
        providerResult: { resultType: "success", textResultForLlm: "done" },
        message: {
          role: "toolResult",
          toolCallId: "call-stale",
          toolName: "read",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 3,
        },
      }),
    ).rejects.toThrow(/no longer active|authority is closed/u);
  });

  it("does not persist nested SDK completion events without a provider result", async () => {
    const { journal, session, target } = await createFixture(undefined, undefined, true);
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-nested", {
        content: "checking",
        messageId: "assistant-nested",
        toolRequests: [{ arguments: {}, name: "openclaw", toolCallId: "nested-call" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "nested-result", {
        result: { content: "nested catalog result" },
        success: true,
        toolCallId: "nested-call",
      }),
    );

    await expect(journal.barrier("nested completion")).rejects.toMatchObject({
      code: "transcript_persistence_failed",
    });
    expect(transcriptMessages(await readSessionTranscriptEvents(target))).toHaveLength(1);
  });

  it("rejects a late provider completion after an earlier result fails closed", async () => {
    const { journal, session } = await createFixture(undefined, undefined, true);
    const abort = vi.spyOn(session, "abort");
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-late-result", {
        content: "checking",
        messageId: "assistant-late-result",
        toolRequests: [
          { arguments: {}, name: "read", toolCallId: "call-first" },
          { arguments: {}, name: "read", toolCallId: "call-late" },
        ],
      }),
    );
    const first = journal.recordProviderToolResult({
      providerResult: { resultType: "success", textResultForLlm: "first" },
      message: {
        role: "toolResult",
        toolCallId: "call-first",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: 3,
      },
    });
    const firstRejected = expect(first).rejects.toThrow(
      "Copilot emitted an unmatched tool result: call-unexpected",
    );
    await expect(
      journal.recordProviderToolResult({
        providerResult: { resultType: "success", textResultForLlm: "unexpected" },
        message: {
          role: "toolResult",
          toolCallId: "call-unexpected",
          toolName: "read",
          content: [{ type: "text", text: "unexpected" }],
          isError: false,
          timestamp: 4,
        },
      }),
    ).rejects.toThrow("Copilot emitted an unmatched tool result: call-unexpected");
    await firstRejected;

    await expect(
      journal.recordProviderToolResult({
        providerResult: { resultType: "success", textResultForLlm: "late" },
        message: {
          role: "toolResult",
          toolCallId: "call-late",
          toolName: "read",
          content: [{ type: "text", text: "late" }],
          isError: false,
          timestamp: 5,
        },
      }),
    ).rejects.toThrow("Copilot emitted an unmatched tool result: call-unexpected");
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
