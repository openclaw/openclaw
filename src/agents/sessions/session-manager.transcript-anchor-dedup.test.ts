// Regression for #152511: duplicate keyed-user delivery must degrade to the
// already-persisted entry (anchor omitted) when the transcript projection index
// is transiently dirty, instead of hard-throwing "Session transcript anchor was
// not returned". This file was migrated out of the removed
// session-manager.user-idempotency.test.ts (deleted in main "remove low-value
// tests" batch d124) and kept as a focused, high-value regression.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: text,
    timestamp: 1,
  };
}

describe("SessionManager transcript anchor dedup", () => {
  it("returns the existing keyed user turn when the transcript index is transiently dirty", async () => {
    // Repro for #152511: after the agent replies into a captured conversation
    // turn, reply-capture writes audit artifacts with appendMode "side", which
    // transiently marks the transcript projection index as needing reconcile.
    // While dirty, readActiveTranscriptEntryAnchor returns undefined. A duplicate
    // keyed-user delivery in that window hits the in-memory dedup branch, which
    // must degrade to the already-persisted entry rather than hard-throwing
    // "Session transcript anchor was not returned".
    const dir = tempDirs.make("openclaw-session-anchor-dedup-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-dirty-index-dedup",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-dirty-index-dedup",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "quick follow-up",
      idempotencyKey: "runtime-user-dirty-index-dedup:user",
      timestamp: 1,
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "existing-assistant",
      message: buildAssistantMessage("previous answer"),
      now: 1,
    });

    const sessionManager = SessionManager.open(scope, dir);
    // The keyed user becomes the active turn in this manager's in-memory index.
    const appendedId = sessionManager.appendMessage(userMessage);
    expect(appendedId).toBeDefined();

    // Simulate the side-append window: mark the projection index dirty so the
    // anchor read returns undefined, exactly as it does for the ~0.5-10s after a
    // concurrent side-append.
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    // The duplicate keyed-user delivery must not throw; it returns the existing
    // entry with the anchor omitted (appended: false). Pre-fix this threw
    // "Session transcript anchor was not returned".
    const dedup = sessionManager.appendMessageWithTranscriptAnchor(userMessage);
    expect(dedup.appended).toBe(false);
    expect(dedup.entryId).toBe(appendedId);
    expect(dedup.anchor).toBeUndefined();
  });
});
