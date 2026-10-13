import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  loadTranscriptEventsSync,
  readTranscriptMutationAtSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

it("rejects a stale generation and stores prepared messages under the rebased descendant", async () => {
  await withOpenClawTestState({ label: "session-prepared-reparent" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "prepared-reparent",
      sessionKey: "agent:main:prepared-reparent",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope, state.workspaceDir);
    const parentId = expectDefined(
      await manager.appendMessageAsync({
        role: "user",
        content: "first",
        timestamp: 1,
      }),
      "Expected appended message",
    );
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "prepared response ".repeat(8000) }],
      api: "messages" as const,
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: createZeroUsageFixture(),
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const prepared = prepareTranscriptMessageAppend({ message });
    expect(prepared?.persistedMessage).toEqual(message);
    const expectedMutationAt = readTranscriptMutationAtSync(scope);
    const descendant = expectDefined(
      await manager.appendMessageAsync({
        ...message,
        content: [{ type: "text", text: "intervening assistant" }],
      }),
      "Expected appended message",
    );
    const before = loadTranscriptEventsSync(scope);
    const options = {
      message,
      eventId: "prepared-response",
      parentId,
      now: 2,
      appendIntent: "active-branch" as const,
    };
    expect(() =>
      appendTranscriptMessageSnapshotSync(scope, { ...options, expectedMutationAt }, prepared),
    ).toThrow("SQLite transcript changed while preparing rewrite");
    expect(loadTranscriptEventsSync(scope)).toEqual(before);

    expect(appendTranscriptMessageSnapshotSync(scope, options, prepared)).toMatchObject({
      ok: true,
      value: { result: { appended: true, effectiveParentId: descendant } },
    });
    const stored = loadTranscriptEventsSync(scope);
    expect(stored.slice(0, -1)).toEqual(before);
    expect(stored.at(-1)).toMatchObject({
      id: "prepared-response",
      parentId: descendant,
      message,
    });
    const { db } = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    const row = db
      .prepare("SELECT navigation_json FROM transcript_events ORDER BY seq DESC LIMIT 1")
      .get();
    expect(typeof row?.navigation_json).toBe("string");
    if (typeof row?.navigation_json !== "string") {
      throw new Error("Expected compressed rebased transcript metadata");
    }
    expect(JSON.parse(row.navigation_json).report.entry.parentId).toBe(descendant);
  });
});
