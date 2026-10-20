import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it } from "vitest";
import { openFileBackedSessionManagerForTest } from "../../../test/helpers/session-manager-file-fixture.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { parseOpaqueLeafEntry } from "./session-manager-codec.js";
import {
  assistantText as buildAssistantMessage,
  sessionScope,
} from "./session-manager-fixtures.test-support.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { text } from "./session-message-fixtures.test-support.js";

const tempDirs = createTempDirTracker();
const replayLimits = { maxBytes: 100_000, maxEvents: 100 };
afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
});

function createScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-manager-compat-");
  const scope = sessionScope(path.join(dir, "openclaw-agent.sqlite"), sessionId);
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
    const cases: Array<[string, string?]> = [
      [
        "Use `[[reply_to_current]]` literally.\nUse `[[tts:text]]spoken[[/tts:text]]` literally.\n```text\n[[audio_as_voice]]\n[[tts:provider=mock voiceId=voice-7]]\n```",
      ],
      ["    [[reply_to_current]]\n    [[audio_as_voice]]"],
      ["[[reply_to_current]\nVisible reply", "Visible reply"],
      ["Visible reply\n[[reply_to_current] literally"],
      ["Generated image\nMEDIA:./render.png"],
      ["  Leading  spaces\r\n\r\n\r\n    indented code\r\n```ts\r\nconst value = 1;\r\n```\r\n"],
    ];
    manager.appendMessage(tagged);
    expect(tagged.content).toEqual(text("Final answer"));
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
      ...cases.map(([input, expected]) => {
        const message = buildAssistantMessage(input);
        manager.appendMessage(message);
        expect(message.content).toEqual(text(expected ?? input));
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

  it("retains the append transaction fence when another write starts after commit", async () => {
    const { dir, scope, persist } = createScope("sqlite-append-fence-session");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persist("base", { role: "user", content: "question" });
    const manager = SessionManager.open(scope, dir);
    const temporaryId = manager.appendMessage(buildAssistantMessage("temporary"));
    const afterAppend = await loadTranscriptEvents(scope);
    const base = afterAppend[1];
    assert(base && typeof base === "object", "Expected persisted base transcript event");
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

  it("keeps the bounded tree unchanged after a rejected tail rewrite", async () => {
    const { dir, scope } = createScope("tail-rewrite");
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      activeWriterRunId: "original-writer",
      lifecycleRevision: "original-lifecycle",
    });
    const seed = SessionManager.open(scope, dir);
    const earlierId = seed.appendMessage(makeUserMessage("earlier history", 1));
    const questionId = seed.appendMessage(makeUserMessage("question", 2));
    const temporaryId = seed.appendMessage(buildAssistantMessage("temporary error"));
    const metadataId = seed.appendCustomEntry("preserved-state", { retained: true });
    const labelId = seed.appendLabelChange(temporaryId, "temporary label");
    const originalEvents = loadTranscriptEventsSync(scope);
    const manager = SessionManager.open(scope, dir, { maxEvents: 3, maxBytes: 4096 });
    const database = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    const readRows = () =>
      database.db
        .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
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
    database.db.exec(`CREATE TRIGGER reject_tail_rewrite BEFORE INSERT ON transcript_events
          BEGIN SELECT RAISE(ABORT, 'tail rewrite failed'); END;`);
    const rewrite = () =>
      withOwnedSessionTranscriptWrites(
        { withTranscriptWrite: async (run) => await run() },
        async () =>
          manager.removeTrailingEntries((entry) => entry.id === temporaryId, {
            preserveTrailing: (entry) => entry.type === "custom" || entry.type === "label",
          }),
      );

    await expect(rewrite()).rejects.toThrow();
    expect(readRows()).toEqual(beforeRows);
    expect(readManager()).toEqual(beforeManager);

    database.db.exec("DROP TRIGGER reject_tail_rewrite");
    await expect(rewrite()).resolves.toBe(1);
    expect(manager.getEntry(temporaryId)).toBeUndefined();
    expect(manager.getLabel(temporaryId)).toBeUndefined();
    // The next reader must work immediately, without waiting for a projection rebuild.
    const reopened = SessionManager.open(scope, dir, { maxEvents: 3, maxBytes: 4096 });
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
      manager.getPersistedEntries().filter((event) => isRecord(event) && event.id === metadataId),
    ).toEqual(expectedRetained.filter((event) => isRecord(event) && event.id === metadataId));
    expect(manager.getLeafId()).toBe(questionId);
    expect(manager.getAppendParentId()).toBe(questionId);
  });
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

async function appendSetupMetadata(manager: SessionManager) {
  const modelId = await manager.appendModelChange("openai", "gpt-5.5");
  const thinkingId = await manager.appendThinkingLevelChange("off");
  const metadataId = manager.appendCustomEntry("model-snapshot", {
    modelApi: "openai-responses",
    modelId: "gpt-5.5",
    provider: "openai",
  });
  return { modelId, thinkingId, metadataId };
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
  it.each([
    { kind: "subagent-completion-direct", adopts: true },
    { kind: "channel-final", adopts: false },
    { kind: undefined, adopts: false },
  ] as const)("keyed replay behind a $kind mirror (adopts: $adopts)", async ({ kind, adopts }) => {
    const { dir, scope, user, persist } = await userSession();
    await persist("wake-user", user);
    expect(
      await appendAssistantMessageToSessionTranscript({
        ...scope,
        text: "Synthetic child result",
        idempotencyKey: "announce:child:text-direct",
        ...(kind ? { deliveryMirror: { kind } } : {}),
      }),
    ).toMatchObject({ ok: true });
    const manager = await SessionManager.openBoundedAsync(scope, { cwd: dir, ...replayLimits });
    if (adopts) {
      expect(await manager.appendMessageAsync(user)).toBe("wake-user");
      expect(manager.appendMessage(user)).toBe("wake-user");
    } else {
      // Unmarked historical mirrors and ordinary final replies still close turns.
      await expect(manager.appendMessageAsync(user)).rejects.toThrow(
        "Session transcript keyed user is outside the current turn",
      );
      expect(() => manager.appendMessage(user)).toThrow(
        "Session transcript keyed user is outside the current turn",
      );
    }
    expectSingleUser(await loadTranscriptEvents(scope), user.idempotencyKey);
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
    const manager = SessionManager.openBounded(scope, { cwd: dir, ...replayLimits });
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
    const { modelId, thinkingId, metadataId } = await appendSetupMetadata(manager);
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

  it.each([
    ["session setup metadata", true],
    ["runtime context and compaction", false],
  ] as const)("adopts a persisted user across %s", async (_name, excluded) => {
    const { dir, scope, user, persist } = await userSession();
    const input = excluded ? { ...user, excludeFromContext: true } : user;
    if (!excluded) {
      await persist("requester-final", buildAssistantMessage("Earlier requester turn is complete"));
    }
    await persist("pre-persisted-user", input);
    const manager = excluded
      ? SessionManager.openBounded(scope, { cwd: dir, ...replayLimits })
      : SessionManager.open(scope, dir);
    let parentId: string;
    if (excluded) {
      parentId = (await appendSetupMetadata(manager)).metadataId;
      expect(manager.appendMessageWithTranscriptAnchor({ ...input, timestamp: 2 })).toMatchObject({
        entryId: "pre-persisted-user",
        message: input,
        anchor: { entryId: "pre-persisted-user", idempotencyKey: user.idempotencyKey },
      });
    } else {
      manager.appendCustomMessageEntry(
        OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
        "Child completed; summarize its result.",
        false,
      );
      parentId = manager.appendCompaction("Compacted history", "pre-persisted-user", 100);
      expect(manager.appendMessage(input)).toBe("pre-persisted-user");
    }
    expect(manager.getAppendParentId()).toBe(parentId);
    const id = manager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events).toContainEqual(expect.objectContaining({ id, parentId }));
    expectSingleUser(events, user.idempotencyKey);
  });
});
