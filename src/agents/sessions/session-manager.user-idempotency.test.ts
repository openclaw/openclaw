// Focused coverage for exact-key user admission and physical SQLite parent ownership.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
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
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionManager user idempotency", () => {
  it("preserves distinct keyed user turns with the same visible text", () => {
    const sessionManager = SessionManager.inMemory();
    const makeMessage = (idempotencyKey: string, timestamp: number) => ({
      role: "user" as const,
      content: "same question",
      idempotencyKey,
      timestamp,
    });
    const first = sessionManager.appendMessage(makeMessage("first-run:user", 1));
    const second = sessionManager.appendMessage(makeMessage("second-run:user", 2));

    expect(second).not.toBe(first);
    expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("allows an explicitly caller-checked keyed user append", () => {
    const sessionManager = SessionManager.inMemory();
    const message = {
      role: "user" as const,
      content: "caller-owned user",
      idempotencyKey: "caller-checked:user",
      timestamp: 1,
    };
    const first = sessionManager.appendMessage(message);

    expect(sessionManager.appendMessage(message, { idempotencyLookup: "caller-checked" })).not.toBe(
      first,
    );
  });

  it.each([false, true])(
    "rejects a keyed user collision outside the current SQLite append parent (excluded: %s)",
    async (excludeFromContext) => {
      const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
      const scope = {
        agentId: "main",
        sessionId: "sqlite-runtime-user-ancestor",
        sessionKey: "agent:main:dashboard:sqlite-runtime-user-ancestor",
        storePath: path.join(dir, "sessions.json"),
      };
      const userMessage = {
        role: "user" as const,
        content: "question",
        idempotencyKey: "runtime-user-ancestor:user",
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
        timestamp: 1,
      };
      await upsertSessionEntryCore(scope, {
        sessionFile: formatSqliteSessionFileMarker(scope),
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "pre-persisted-user",
        message: userMessage,
        now: 1,
      });
      await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "persisted-assistant",
        message: {
          ...buildAssistantMessage("answer"),
          ...(excludeFromContext ? { excludeFromContext: true } : {}),
        },
        parentId: "pre-persisted-user",
      });
      const sessionManager = SessionManager.openBounded(scope, {
        cwd: dir,
        maxBytes: 100_000,
        maxEvents: 100,
      });

      expect(() => sessionManager.appendMessage(userMessage)).toThrow(
        "Session transcript keyed user is outside the current turn",
      );
      expect(sessionManager.getAppendParentId()).toBe("persisted-assistant");
      expect(sessionManager.resolveCurrentTurnEntryId(() => true)).toBe(
        excludeFromContext ? "persisted-assistant" : null,
      );
      expect(
        (await loadTranscriptEvents(scope)).filter(
          (event) =>
            (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
              "user" &&
            (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
              userMessage.idempotencyKey,
        ),
      ).toHaveLength(1);
    },
  );

  it("adopts a keyed user persisted after the manager loaded", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-concurrent-ingress",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-concurrent-ingress",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-concurrent-ingress:user",
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
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "ingress-persisted-user",
      message: userMessage,
      now: 2,
      parentId: "existing-assistant",
    });
    const modelChangeId = await sessionManager.appendModelChange("openai", "gpt-5.5");
    const thinkingId = await sessionManager.appendThinkingLevelChange("off");
    const metadataId = sessionManager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });

    expect(sessionManager.appendMessage(userMessage)).toBe("ingress-persisted-user");
    expect(sessionManager.getAppendParentId()).toBe(metadataId);

    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events.find((event) => (event as { id?: string }).id === modelChangeId)).toMatchObject({
      parentId: "ingress-persisted-user",
    });
    expect(events.find((event) => (event as { id?: string }).id === thinkingId)).toMatchObject({
      parentId: modelChangeId,
    });
    expect(events.find((event) => (event as { id?: string }).id === metadataId)).toMatchObject({
      parentId: thinkingId,
    });
    expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
      parentId: metadataId,
    });
    expect(
      events.filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "adopts a persisted user across context-free session setup metadata (excluded: %s)",
    async (excludeFromContext) => {
      const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
      const scope = {
        agentId: "main",
        sessionId: "sqlite-runtime-user-setup-metadata",
        sessionKey: "agent:main:dashboard:sqlite-runtime-user-setup-metadata",
        storePath: path.join(dir, "sessions.json"),
      };
      const userMessage = {
        role: "user" as const,
        content: "question",
        idempotencyKey: "runtime-user-setup-metadata:user",
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
        timestamp: 1,
      };
      await upsertSessionEntryCore(scope, {
        sessionFile: formatSqliteSessionFileMarker(scope),
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      await appendTranscriptMessage(scope, {
        cwd: dir,
        eventId: "pre-persisted-user",
        message: userMessage,
        now: 1,
      });

      const sessionManager = SessionManager.openBounded(scope, {
        cwd: dir,
        maxBytes: 100_000,
        maxEvents: 100,
      });
      await sessionManager.appendModelChange("openai", "gpt-5.5");
      await sessionManager.appendThinkingLevelChange("off");
      const metadataId = sessionManager.appendCustomEntry("model-snapshot", {
        modelApi: "openai-responses",
        modelId: "gpt-5.5",
        provider: "openai",
      });

      expect(
        sessionManager.appendMessageWithTranscriptAnchor({ ...userMessage, timestamp: 2 }),
      ).toMatchObject({
        entryId: "pre-persisted-user",
        message: userMessage,
        anchor: { entryId: "pre-persisted-user", idempotencyKey: userMessage.idempotencyKey },
      });
      expect(sessionManager.getAppendParentId()).toBe(metadataId);

      const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
      const events = await loadTranscriptEvents(scope);
      expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
        parentId: metadataId,
      });
      expect(
        events.filter(
          (event) =>
            (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
              "user" &&
            (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
              userMessage.idempotencyKey,
        ),
      ).toHaveLength(1);
    },
  );

  it("adopts the current keyed user across a compaction boundary", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-compaction",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-compaction",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-compaction:user",
      timestamp: 1,
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "pre-persisted-user",
      message: userMessage,
      now: 1,
    });
    const sessionManager = SessionManager.open(scope, dir);
    const compactionId = sessionManager.appendCompaction(
      "Compacted history",
      "pre-persisted-user",
      100,
    );

    expect(sessionManager.appendMessage(userMessage)).toBe("pre-persisted-user");
    expect(sessionManager.getAppendParentId()).toBe(compactionId);

    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
      parentId: compactionId,
    });
    expect(
      events.filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
  });

  it("returns the existing keyed user turn when the transcript index is transiently dirty", async () => {
    // Repro for #152511: after the agent replies into a captured conversation
    // turn, reply-capture writes audit artifacts with appendMode "side", which
    // transiently marks the transcript projection index as needing reconcile.
    // While dirty, readActiveTranscriptEntryAnchor returns undefined. A duplicate
    // keyed-user delivery in that window hits the in-memory dedup branch, which
    // must degrade to the already-persisted entry rather than hard-throwing
    // "Session transcript anchor was not returned".
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
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
