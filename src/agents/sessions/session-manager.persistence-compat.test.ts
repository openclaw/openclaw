import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  readSessionTranscriptWatermark,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
});

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

function createScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-manager-compat-");
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  const persist = (eventId: string, message: unknown) =>
    appendTranscriptMessage(scope, { cwd: dir, eventId, message });
  return { dir, scope, persist };
}

function header(id: string, cwd: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session", version, id, timestamp: new Date(0).toISOString(), cwd };
}

function row(type: string, id: string, parent: string | null, fields: Record<string, unknown>) {
  return { type, id, parentId: parent, timestamp: new Date(1).toISOString(), ...fields };
}

describe("SessionManager persistence compatibility", () => {
  it("persists canonical delivery facts and keeps the live assistant bytes identical", async () => {
    const { dir, scope } = createScope("directive-session");
    const manager = SessionManager.open(scope, dir);
    const tagged = buildAssistantMessage(
      [
        "[[reply_to_current]]",
        "[[reply_to:message-7]]",
        "[[audio_as_voice]]",
        "[[tts:provider=mock voiceId=voice-7]]",
        "Final answer [[tts:text]]Spoken answer[[/tts:text]]",
      ].join("\n"),
    );
    const cases = [
      {
        input:
          "Use `[[reply_to_current]]` literally.\nUse `[[tts:text]]spoken[[/tts:text]]` literally.\n```text\n[[audio_as_voice]]\n[[tts:provider=mock voiceId=voice-7]]\n```",
      },
      { input: "    [[reply_to_current]]\n    [[audio_as_voice]]" },
      { input: "[[reply_to_current]\nVisible reply", expected: "Visible reply" },
      { input: "Visible reply\n[[reply_to_current] literally" },
      { input: "Generated image\nMEDIA:./render.png" },
      {
        input:
          "  Leading  spaces\r\n\r\n\r\n    indented code\r\n```ts\r\nconst value = 1;\r\n```\r\n",
      },
    ];
    manager.appendMessage(tagged);
    expect(tagged.content).toEqual([{ type: "text", text: "Final answer" }]);
    expect(tagged).toMatchObject({
      openclawDelivery: {
        audioAsVoice: true,
        replyToId: "message-7",
        tts: {
          tagged: true,
          text: "Spoken answer",
          directives: [{ provider: "mock", values: { voiceid: "voice-7" } }],
        },
      },
    });
    const messages = [
      tagged,
      ...cases.map(({ input, expected }) => {
        const message = buildAssistantMessage(input);
        manager.appendMessage(message);
        expect(message.content).toEqual([{ type: "text", text: expected ?? input }]);
        expect(message).not.toHaveProperty("openclawDelivery");
        return message;
      }),
    ];
    const persisted = (await loadTranscriptEvents(scope)).flatMap((event) =>
      isRecord(event) && event.type === "message" ? [event.message] : [],
    );
    expect(persisted).toEqual(messages);
    expect(SessionManager.open(scope, dir).buildSessionContext().messages).toEqual(messages);
  });

  it("removes an active tail followed by a later inactive raw row", async () => {
    const { dir, scope } = createScope("later-inactive-row-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(
      replaceTranscriptEventsSync(scope, [
        header(scope.sessionId, dir, 3),
        row("message", "root", null, { message: { role: "user", content: "root" } }),
        row("message", "active", "root", { message: buildAssistantMessage("active") }),
        row("message", "inactive", "root", {
          appendMode: "side",
          message: buildAssistantMessage("inactive"),
        }),
        row("leaf", "active-leaf", "inactive", { targetId: "active", appendParentId: "active" }),
      ]),
    ).toBe(true);
    await waitForSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      path: path.join(dir, "openclaw-agent.sqlite"),
    });

    const manager = SessionManager.open(scope, dir);
    expect(manager.removeTrailingEntries((entry) => entry.id === "active")).toBe(1);

    const events = await loadTranscriptEvents(scope);
    expect(events).not.toContainEqual(expect.objectContaining({ id: "active" }));
    expect(events).toContainEqual(
      expect.objectContaining({ id: "inactive", parentId: "root", appendMode: "side" }),
    );
  });

  it("preserves and rebases trailing metadata, labels, and leaf controls", async () => {
    const { dir, scope } = createScope("sqlite-remove-controls-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const events = [
      header(scope.sessionId, dir),
      row("message", "user", null, { message: { role: "user", content: "question" } }),
      row("message", "temporary", "user", { message: buildAssistantMessage("temporary") }),
      row("label", "temporary-label", "temporary", { targetId: "temporary", label: "retry" }),
      row("label", "nested-temporary-label", "temporary-label", {
        targetId: "temporary-label",
        label: "nested retry",
      }),
      row("custom", "plugin-state", "nested-temporary-label", {
        customType: "plugin-state",
        data: { enabled: true },
      }),
      row("session_info", "session-info", "plugin-state", { name: "kept session" }),
      row("leaf", "leaf-control", "session-info", {
        targetId: "temporary",
        appendParentId: "temporary",
      }),
    ];
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    const generationBefore = readSessionTranscriptWatermark(scope).generation;
    const manager = SessionManager.open(scope, dir);

    expect(
      manager.removeTrailingEntries((entry) => entry.id === "temporary", {
        preserveTrailing: (entry) =>
          entry.type === "custom" || entry.type === "label" || entry.type === "session_info",
      }),
    ).toBe(1);

    expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "user", parentId: null, type: "message" },
      { id: "plugin-state", parentId: "user", type: "custom" },
      { id: "session-info", parentId: "plugin-state", type: "session_info" },
      {
        id: "leaf-control",
        parentId: "session-info",
        targetId: "user",
        appendParentId: "user",
        type: "leaf",
      },
    ]);
  });

  it("allows stale suffix cleanup to remain a no-op when its target is absent", async () => {
    const { dir, scope, persist } = createScope("sqlite-remove-concurrent-noop-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persist("base", { role: "user", content: "question" });
    const manager = SessionManager.open(scope, dir);
    await persist("concurrent", { role: "user", content: "concurrent" });

    expect(manager.removeTrailingEntries((entry) => entry.id === "absent")).toBe(0);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
    ]);
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { id: scope.sessionId },
      { id: "base" },
      { id: "concurrent" },
    ]);
  });

  it("rejects stale suffix removal without deleting concurrent history", async () => {
    const { dir, scope, persist } = createScope("sqlite-remove-concurrent-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persist("base", { role: "user", content: "question" });
    await persist("temporary", buildAssistantMessage("temporary"));
    const manager = SessionManager.open(scope, dir);
    await persist("concurrent", { role: "user", content: "concurrent" });

    expect(() => manager.removeTrailingEntries((entry) => entry.id === "temporary")).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "temporary" }] },
    ]);
    expect(
      (await loadTranscriptEvents(scope)).map((event) =>
        event && typeof event === "object" && "id" in event ? event.id : undefined,
      ),
    ).toEqual([scope.sessionId, "base", "temporary", "concurrent"]);
  });

  it("retains the append transaction fence when another write starts after commit", async () => {
    const { dir, scope, persist } = createScope("sqlite-append-fence-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persist("base", { role: "user", content: "question" });
    const manager = SessionManager.open(scope, dir);
    const temporaryId = manager.appendMessage(buildAssistantMessage("temporary"));
    const afterAppend = await loadTranscriptEvents(scope);
    const base = afterAppend[1];
    if (!base || typeof base !== "object") {
      throw new Error("Expected persisted base transcript event");
    }
    expect(
      replaceTranscriptEventsSync(scope, [
        afterAppend[0],
        { ...base, message: { role: "user", content: "rewritten question" } },
        afterAppend[2],
      ]),
    ).toBe(true);

    expect(() => manager.removeTrailingEntries((entry) => entry.id === temporaryId)).toThrow(
      "SQLite transcript changed while preparing suffix removal",
    );
    expect(await loadTranscriptEvents(scope)).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "rewritten question" } },
      { id: temporaryId },
    ]);
  });

  it.each(["bounded-sqlite", "identity", "writer", "lifecycle"])(
    "keeps the live tree unchanged after a rejected %s tail rewrite",
    async (failure) => {
      const { dir, scope } = createScope("tail-rewrite");
      const initialEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activeWriterRunId: "original-writer",
        lifecycleRevision: "original-lifecycle",
      };
      await upsertSessionEntryCore(scope, initialEntry);
      const seed = SessionManager.open(scope, dir);
      const earlierId = seed.appendMessage(makeUserMessage("earlier history", 1));
      const questionId = seed.appendMessage({ role: "user", content: "question", timestamp: 2 });
      const temporaryId = seed.appendMessage(buildAssistantMessage("temporary error"));
      const metadataId = seed.appendCustomEntry("preserved-state", { retained: true });
      const labelId = seed.appendLabelChange(temporaryId, "temporary label");
      const originalEvents = loadTranscriptEventsSync(scope);
      const manager = SessionManager.open(
        scope,
        dir,
        failure === "bounded-sqlite" ? { maxEvents: 3, maxBytes: 4096 } : undefined,
      );
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const readRows = () =>
        database.db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId);
      const readManager = () => ({
        entries: manager.getEntries(),
        leafId: manager.getLeafId(),
        appendParentId: manager.getAppendParentId(),
        label: manager.getLabel(temporaryId),
        target: manager.getSessionTarget(),
        context: manager.buildSessionContext(),
      });
      const beforeRows = readRows();
      const beforeManager = structuredClone(readManager());
      if (failure.endsWith("sqlite")) {
        database.db.exec(`CREATE TRIGGER reject_tail_rewrite BEFORE INSERT ON transcript_events
          BEGIN SELECT RAISE(ABORT, 'tail rewrite failed'); END;`);
      } else {
        await updateSessionEntry(scope, () =>
          failure === "identity"
            ? { sessionId: "replacement-session" }
            : failure === "writer"
              ? { activeWriterRunId: "replacement-writer" }
              : { lifecycleRevision: "replacement-lifecycle" },
        );
      }
      const remove = () =>
        manager.removeTrailingEntries((entry) => entry.id === temporaryId, {
          preserveTrailing: (entry) => entry.type === "custom" || entry.type === "label",
        });
      const rewrite = () =>
        withOwnedSessionTranscriptWrites(
          {
            ...(failure === "writer" || failure === "lifecycle"
              ? {
                  sessionTarget: {
                    ...scope,
                    expectedWriterRunId: initialEntry.activeWriterRunId,
                    expectedLifecycleRevision: initialEntry.lifecycleRevision,
                  },
                }
              : {}),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => remove(),
        );

      await expect(rewrite()).rejects.toThrow();
      expect(readRows()).toEqual(beforeRows);
      expect(readManager()).toEqual(beforeManager);

      if (failure.endsWith("sqlite")) {
        database.db.exec("DROP TRIGGER reject_tail_rewrite");
      } else {
        await upsertSessionEntryCore(scope, initialEntry);
      }
      await expect(rewrite()).resolves.toBe(1);
      expect(manager.getEntry(temporaryId)).toBeUndefined();
      expect(manager.getLabel(temporaryId)).toBeUndefined();
      // The next reader must work immediately, without waiting for a projection rebuild.
      const reopened =
        failure === "bounded-sqlite"
          ? SessionManager.open(scope, dir, { maxEvents: 3, maxBytes: 4096 })
          : SessionManager.open(scope, dir);
      if (failure === "bounded-sqlite") {
        const expectedRetained = structuredClone(
          originalEvents.filter(
            (event) => !isRecord(event) || (event.id !== temporaryId && event.id !== labelId),
          ),
        );
        for (const event of expectedRetained) {
          if (isRecord(event) && event.id === metadataId) {
            event.parentId = questionId;
          }
        }
        const durable = loadTranscriptEventsSync(scope);
        const controls = durable.filter((event) => parseOpaqueLeafEntry(event));
        expect(controls).toHaveLength(1);
        const control = parseOpaqueLeafEntry(controls[0]);
        expect(control).toMatchObject({ parentId: metadataId, targetId: questionId });
        expect(control?.appendParentId ?? control?.targetId).toBe(questionId);
        expect(durable.filter((event) => !parseOpaqueLeafEntry(event))).toEqual(expectedRetained);
        const full = SessionManager.open(scope, dir);
        expect(full.getBranch().map((entry) => entry.id)).toEqual([earlierId, questionId]);
        expect(reopened.getBranch()).toEqual(full.getBranch());
        expect(reopened.buildSessionContext()).toEqual(full.buildSessionContext());
        // The bounded public view normalizes an omitted parent; storage must retain its real ID.
        expect(manager.getEntries()).toEqual(
          expectedRetained.flatMap((event) =>
            isRecord(event) && event.id === metadataId ? [{ ...event, parentId: null }] : [],
          ),
        );
        expect(
          manager
            .getPersistedEntries()
            .filter((event) => isRecord(event) && event.id === metadataId),
        ).toEqual(expectedRetained.filter((event) => isRecord(event) && event.id === metadataId));
        expect(manager.getLeafId()).toBe(questionId);
        expect(manager.getAppendParentId()).toBe(questionId);
      } else {
        expect(reopened.getPersistedEntries()).toEqual(manager.getPersistedEntries());
      }
    },
  );
});

it("keeps file fixture appends and rewrites readable after an unterminated record", async () => {
  const dir = tempDirs.make("openclaw-session-manager-compat-");
  const file = path.join(dir, "unterminated.jsonl");
  await fs.writeFile(file, JSON.stringify(header("unterminated", dir)));
  const manager = openFileBackedSessionManagerForTest(file, dir);
  manager.appendMessage(makeUserMessage("appended", 1));
  expect(openFileBackedSessionManagerForTest(file, dir).buildSessionContext().messages).toEqual([
    expect.objectContaining({ content: "appended", role: "user" }),
  ]);
  expect(manager.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
  expect(openFileBackedSessionManagerForTest(file, dir).buildSessionContext().messages).toEqual([]);
});

async function userSession() {
  const { dir, scope } = createScope("user-replay");
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const user = { ...makeUserMessage("question", 1), idempotencyKey: "run:user" };
  const persist = (eventId: string, message: unknown, parentId?: string) =>
    appendTranscriptMessage(scope, { cwd: dir, eventId, message, now: 1, parentId });
  return { dir, scope, user, persist };
}

function expectSingleUser(events: unknown[], key: string) {
  expect(
    events.filter(
      (event) =>
        isRecord(event) &&
        isRecord(event.message) &&
        event.message.role === "user" &&
        event.message.idempotencyKey === key,
    ),
  ).toHaveLength(1);
}

describe("SessionManager user idempotency", () => {
  it("preserves distinct keyed user turns with the same visible text", () => {
    const manager = SessionManager.inMemory();
    const message = { ...makeUserMessage("same question", 1), idempotencyKey: "first:user" };
    const first = manager.appendMessage(message);
    const second = { ...message, idempotencyKey: "second-run:user", timestamp: 2 };
    expect(manager.appendMessage(second)).not.toBe(first);
    expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("allows an explicitly caller-checked keyed user append", () => {
    const manager = SessionManager.inMemory();
    const message = {
      ...makeUserMessage("caller-owned user", 1),
      idempotencyKey: "caller-checked:user",
    };
    const first = manager.appendMessage(message);
    expect(manager.appendMessage(message, { idempotencyLookup: "caller-checked" })).not.toBe(first);
  });

  it("rejects a keyed user collision behind an excluded assistant", async () => {
    const { dir, scope, user, persist } = await userSession();
    const excluded = { ...user, excludeFromContext: true };
    await persist("pre-persisted-user", excluded);
    await persist(
      "persisted-assistant",
      { ...buildAssistantMessage("answer"), excludeFromContext: true },
      "pre-persisted-user",
    );
    const manager = SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(() => manager.appendMessage(excluded)).toThrow(
      "Session transcript keyed user is outside the current turn",
    );
    expect(manager.getAppendParentId()).toBe("persisted-assistant");
    expect(manager.resolveCurrentTurnEntryId(() => true)).toBe("persisted-assistant");
    expectSingleUser(await loadTranscriptEvents(scope), user.idempotencyKey);
  });

  it("adopts a keyed user persisted after the manager loaded", async () => {
    const { dir, scope, user, persist } = await userSession();
    await persist("existing-assistant", buildAssistantMessage("previous answer"));
    const manager = SessionManager.open(scope, dir);
    await persist("ingress-persisted-user", user, "existing-assistant");
    const modelId = await manager.appendModelChange("openai", "gpt-5.5");
    const thinkingId = await manager.appendThinkingLevelChange("off");
    const metadataId = manager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });
    expect(manager.appendMessage(user)).toBe("ingress-persisted-user");
    expect(manager.getAppendParentId()).toBe(metadataId);
    const assistantId = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toMatchObject([
      { type: "session" },
      { id: "existing-assistant" },
      { id: "ingress-persisted-user" },
      { id: modelId, parentId: "ingress-persisted-user" },
      { id: thinkingId, parentId: modelId },
      { id: metadataId, parentId: thinkingId },
      { id: assistantId, parentId: metadataId },
    ]);
    expectSingleUser(events, user.idempotencyKey);
  });

  it("adopts an excluded persisted user across session setup metadata", async () => {
    const { dir, scope, user, persist } = await userSession();
    const excluded = { ...user, excludeFromContext: true };
    await persist("pre-persisted-user", excluded);
    const manager = SessionManager.openBounded(scope, {
      cwd: dir,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    await manager.appendModelChange("openai", "gpt-5.5");
    await manager.appendThinkingLevelChange("off");
    const metadataId = manager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });
    expect(manager.appendMessageWithTranscriptAnchor({ ...excluded, timestamp: 2 })).toMatchObject({
      entryId: "pre-persisted-user",
      message: excluded,
      anchor: { entryId: "pre-persisted-user", idempotencyKey: user.idempotencyKey },
    });
    expect(manager.getAppendParentId()).toBe(metadataId);
    const id = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toContainEqual(expect.objectContaining({ id, parentId: metadataId }));
    expectSingleUser(events, user.idempotencyKey);
  });

  it("adopts the current keyed user across runtime context and compaction", async () => {
    const { dir, scope, user, persist } = await userSession();
    await persist("requester-final", buildAssistantMessage("Earlier requester turn is complete"));
    await persist("pre-persisted-user", user);
    const manager = SessionManager.open(scope, dir);
    manager.appendCustomMessageEntry(
      OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      "Child completed; summarize its result.",
      false,
    );
    const compactionId = manager.appendCompaction("Compacted history", "pre-persisted-user", 100);
    expect(manager.appendMessage(user)).toBe("pre-persisted-user");
    expect(manager.getAppendParentId()).toBe(compactionId);
    const id = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toContainEqual(expect.objectContaining({ id, parentId: compactionId }));
    expectSingleUser(events, user.idempotencyKey);
  });
});
