import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { readActiveTranscriptStats } from "../../config/sessions/session-accessor.sqlite-history.test-support.js";
import { importSqliteSessionRows } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { readTranscriptStorageRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

const taskState = [
  "TASK-017: analysis completed",
  "Pending: validate /synthetic/output.png",
  "Approval: release pending",
  "Constraint: preserve completed work",
  "Child: synthetic-child waiting",
  "Artifact: synthetic-digest",
  "Do not repeat completed tools",
];

function assertTaskAndToolPairs(manager: SessionManager) {
  const messages = manager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  for (const marker of taskState) {
    expect(serialized).toContain(marker);
  }
  const calls = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
        : [],
    ),
  );
  for (const message of messages) {
    if (message.role === "toolResult") {
      expect(calls.has(message.toolCallId)).toBe(true);
    }
  }
}

it.each(["user", "assistant"] as const)(
  "retains task state through three SQLite compactions with a discarded %s prefix",
  async (prefixRole) => {
    streamMocks.streamSimple.mockImplementation((model, context) => {
      const input = JSON.stringify(context);
      // A split turn has its own summary request without the previous summary.
      // Only carry markers present in this request so the provider cannot mask loss.
      const retainedMarkers = taskState.filter((marker) => input.includes(marker));
      return createAssistantResultStream(
        createAssistant(model, [
          { type: "text", text: retainedMarkers.join("\n") || "Validation prefix completed." },
        ]),
      );
    });
    await withOpenClawTestState({ label: "repeated-context-window" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "context-window",
        sessionKey: "agent:main:context-window",
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
        env: state.env,
      };
      await importSqliteSessionRows({
        ...scope,
        entry: { sessionId: scope.sessionId, updatedAt: 1 },
        readTranscriptEvents: (append) => {
          append({ type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId });
          append({
            type: "message",
            id: "old",
            parentId: null,
            message:
              prefixRole === "assistant"
                ? createAssistant(testModel, [{ type: "text", text: "x".repeat(32_000) }])
                : { role: "user", content: "x".repeat(32_000), timestamp: 1 },
          });
          append({
            type: "message",
            id: "kept",
            parentId: "old",
            message: { role: "user", content: "Continue validation.", timestamp: 2 },
          });
          append({
            type: "compaction",
            id: "cut",
            parentId: "kept",
            firstKeptEntryId: "kept",
            timestamp: "2026-01-01T00:00:00.000Z",
            summary: taskState.join("\n"),
            tokensBefore: 10_000,
          });
          append({
            type: "message",
            id: "tail",
            parentId: "cut",
            message:
              prefixRole === "assistant"
                ? { role: "user", content: "Continue validation.", timestamp: 3 }
                : createAssistant(testModel, [{ type: "text", text: "Validation pending." }]),
          });
        },
      });
      const database = openOpenClawAgentDatabase(scope);
      const original = readTranscriptStorageRows(database, scope.sessionId);
      const digest = (rows: typeof original) =>
        createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      const originalDigest = digest(original);
      const limits = { maxBytes: 20_000, maxEvents: 40 };
      for (let cycle = 0; cycle < 3; cycle++) {
        const manager = await SessionManager.openBoundedAsync(scope, {
          ...limits,
          onTruncated: () => {
            throw new Error("A compacted ancestor consumed the context budget");
          },
        });
        assertTaskAndToolPairs(manager);
        if (cycle === 0 && prefixRole === "assistant") {
          expect(manager.getEntry("old")).toMatchObject({
            type: "model_change",
            provider: testModel.provider,
            modelId: testModel.id,
          });
          expect(manager.buildSessionContext().model).toEqual({
            provider: testModel.provider,
            modelId: testModel.id,
          });
        }
        // Keep enough completed history to exercise the configured retained tail,
        // rather than manual compaction's fallback to a minimal tail for small sessions.
        await manager.appendMessageAsync(
          createAssistant(testModel, [{ type: "text", text: "completed history ".repeat(500) }]),
        );
        await manager.appendMessageAsync({
          role: "user",
          content: "Continue without restating the task.",
          timestamp: cycle + 3,
        });
        const toolCallId = `validation-${cycle}`;
        await manager.appendMessageAsync(
          createAssistant(testModel, [
            { type: "toolCall", id: toolCallId, name: "read", arguments: {} },
          ]),
        );
        await manager.appendMessageAsync({
          role: "toolResult",
          toolCallId,
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "completed ".repeat(80) }],
          timestamp: cycle + 4,
        });
        await manager.appendMessageAsync(
          createAssistant(testModel, [
            { type: "text", text: "Validation recorded; approval pending." },
          ]),
        );
        assertTaskAndToolPairs(manager);
        const { session } = await createTestSession({
          sessionManager: manager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1536 },
            retry: { enabled: false },
          }),
        });
        try {
          const callsBefore = streamMocks.streamSimple.mock.calls.length;
          await session.compact("Preserve pending tasks, approvals, and identifiers.");
          expect(streamMocks.streamSimple.mock.calls.length).toBeGreaterThan(callsBefore);
        } finally {
          session.dispose();
        }
        const reopened = await SessionManager.openBoundedAsync(scope, {
          ...limits,
          onTruncated: () => {
            throw new Error("Compaction did not release its read budget");
          },
        });
        assertTaskAndToolPairs(reopened);
        expect(reopened.buildSessionContext().messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolCallId })]),
        );
        expect(readActiveTranscriptStats(scope).sizeBytes).toBeLessThan(limits.maxBytes);
        expect(
          digest(readTranscriptStorageRows(database, scope.sessionId).slice(0, original.length)),
        ).toBe(originalDigest);
      }
    });
  },
);
