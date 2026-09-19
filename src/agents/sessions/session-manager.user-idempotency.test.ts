// Focused coverage for exact-key user admission and physical SQLite parent ownership.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    const modelChangeId = sessionManager.appendModelChange("openai", "gpt-5.5");
    const thinkingId = sessionManager.appendThinkingLevelChange("off");
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
      sessionManager.appendModelChange("openai", "gpt-5.5");
      sessionManager.appendThinkingLevelChange("off");
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

  it("degrades instead of throwing when the transcript index is dirty after a side-append (#152511)", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-side-append-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-side-append-dirty",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-side-append-dirty",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-side-append:user",
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

    // Simulate conversation-turn-capture writing a side-append custom audit
    // artifact directly to the transcript store, which marks the projection
    // index dirty. Custom entries are context metadata — the turn resolver
    // skips them — so the keyed user remains the current turn entry even
    // though readActiveTranscriptEntryAnchor returns undefined while dirty.
    appendTranscriptEventSync(scope, {
      type: "custom",
      id: "turn-capture-audit",
      parentId: "pre-persisted-user",
      timestamp: new Date().toISOString(),
      customType: "turn-capture",
      data: { captured: true },
      appendMode: "side",
    });

    // The keyed-user dedup path must reload the canonical transcript, confirm
    // the cached user is still the current turn entry, and return the dedup
    // hit without an anchor — rather than throwing "Session transcript anchor
    // was not returned".
    const result = sessionManager.appendMessageWithTranscriptAnchor(userMessage);
    expect(result).toMatchObject({
      entryId: "pre-persisted-user",
      message: userMessage,
      appended: false,
    });
    expect(result).not.toHaveProperty("anchor");

    // Subsequent assistant persistence must succeed after the anchorless dedup.
    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
      parentId: "turn-capture-audit",
    });
  });

  it("rejects an anchorless cached replay after a concurrent branch change displaces the user (#152511)", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-branch-change-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-branch-change",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-branch-change",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-branch-change:user",
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

    // Another manager appends a competing user + assistant on a different
    // branch, displacing the cached keyed user, then writes a side-append
    // custom artifact that dirties the projection index.
    const competingUser = {
      role: "user" as const,
      content: "competing question",
      idempotencyKey: "competing-branch:user",
      timestamp: 2,
    };
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "competing-user",
      message: competingUser,
      now: 2,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "competing-assistant",
      message: buildAssistantMessage("competing answer"),
      parentId: "competing-user",
    });
    appendTranscriptEventSync(scope, {
      type: "custom",
      id: "turn-capture-audit",
      parentId: "competing-assistant",
      timestamp: new Date().toISOString(),
      customType: "turn-capture",
      data: { captured: true },
      appendMode: "side",
    });

    // After reload, resolveCurrentTurnEntryId returns the competing assistant,
    // not the cached keyed user. The dedup path must NOT return a stale
    // dedup hit; it falls through to the normal append path which rejects
    // the keyed user as outside the current turn.
    expect(() => sessionManager.appendMessageWithTranscriptAnchor(userMessage)).toThrow(
      "Session transcript keyed user is outside the current turn",
    );

    // Only one entry with the original key should exist in the transcript.
    const events = await loadTranscriptEvents(scope);
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

  it("rejects an anchorless cached replay after a concurrent turn completion (#152511)", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-turn-completion-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-turn-completion",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-turn-completion",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-turn-completion:user",
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

    // Another manager appends an assistant reply (completing the turn) and
    // then a side-append custom artifact that dirties the projection index.
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "assistant-reply",
      message: buildAssistantMessage("answer"),
      parentId: "pre-persisted-user",
    });
    appendTranscriptEventSync(scope, {
      type: "custom",
      id: "turn-capture-audit",
      parentId: "assistant-reply",
      timestamp: new Date().toISOString(),
      customType: "turn-capture",
      data: { captured: true },
      appendMode: "side",
    });

    // After reload, resolveCurrentTurnEntryId returns the assistant reply,
    // not the cached keyed user — the turn has completed. The dedup path
    // must NOT return a stale dedup hit; it falls through to the normal
    // append path which rejects the keyed user as outside the current turn.
    expect(() => sessionManager.appendMessageWithTranscriptAnchor(userMessage)).toThrow(
      "Session transcript keyed user is outside the current turn",
    );

    const events = await loadTranscriptEvents(scope);
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
});
