import path from "node:path";
import { serialize } from "node:v8";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import * as configEnv from "../../config/config-env-vars.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadSessionEntry,
  loadTranscriptEvents,
  readTranscriptRawDelta,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { buildSessionContext, CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);

function createScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-manager-");
  return { dir, scope: sessionScope(path.join(dir, "sessions.json"), sessionId) };
}

function sessionHeader(id: string, cwd: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session" as const, version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function openMarker(marker: string, sessionKey: string, cwd: string): SessionManager {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return SessionManager.open({ ...target, sessionKey }, cwd);
}

function appendState(manager: SessionManager) {
  return [manager.getEntries(), manager.getLeafId(), manager.getAppendParentId()];
}

function branchIds(manager: SessionManager) {
  return manager.getBranch().map((entry) => entry.id);
}

async function expectRejectedAppend(
  manager: SessionManager,
  events: () => Promise<unknown>,
  append: () => unknown,
) {
  const before = [manager.getBranch(), await events()];
  expect(append).toThrow("SQLite transcript changed while preparing rewrite");
  expect([manager.getBranch(), await events()]).toEqual(before);
}

describe("SessionManager.open", () => {
  it("commits ordered metadata and custom messages with Windows environment semantics off-thread", async () => {
    const { dir, scope: target } = createScope("metadata-worker");
    target.storePath = path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const manager = SessionManager.open(target, dir);
    const sql = observeHostDataSql();
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((env) => {
      const { OPENCLAW_STATE_DIR, ...rest } = env;
      const captured = withMockedPlatform("win32", () =>
        cloneEnv({
          ...rest,
          OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
        }),
      );
      expect(() => serialize(captured)).toThrow(
        expect.objectContaining(
          process.versions.bun
            ? { name: "DataCloneError", code: 25 }
            : { name: "Error", message: "#<Object> could not be cloned." },
        ),
      );
      return captured;
    });
    let ids: Array<string | undefined>;
    try {
      ids = await Promise.all([
        manager.appendModelChange("p", "m"),
        manager.appendThinkingLevelChange("high"),
        manager.appendMessageAsync({
          role: "custom",
          customType: "synthetic-note",
          content: "worker note",
          display: false,
          timestamp: 1,
        }),
      ]);
    } finally {
      sql.restore();
      clone.mockRestore();
    }
    const dataSql =
      /\b(?:transcript_events|transcript_payloads|session_windows|session_nodes)\b|BEGIN\s+IMMEDIATE/i;
    expect(sql.queries.filter((query) => dataSql.test(query))).toEqual([]);
    expect(manager.getEntries()).toMatchObject([
      { type: "model_change", id: ids[0], parentId: null, provider: "p", modelId: "m" },
      { type: "thinking_level_change", id: ids[1], parentId: ids[0], thinkingLevel: "high" },
      {
        type: "message",
        id: ids[2],
        parentId: ids[1],
        message: { role: "custom", content: "worker note" },
      },
    ]);
    expect(SessionManager.open(target, dir).getEntries()).toEqual(manager.getEntries());
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
  });

  it("does not overwrite a rebound session row when the first append seeds its header", async () => {
    const { dir, scope } = createScope("sqlite-stale-appender");
    await upsertSessionEntryCore(scope, {
      sessionId: "sqlite-current-owner",
      updatedAt: 456,
      label: "preserved",
    });
    const before = loadSessionEntry(scope);
    const manager = SessionManager.open(scope, dir);

    expect(() => manager.appendMessage(makeUserMessage("stale", 1))).toThrow(
      "Session transcript header was not persisted",
    );
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("rejects invalid entries before mutating in-memory state", async () => {
    const manager = SessionManager.inMemory("/tmp");
    const entriesBefore = manager.getEntries();

    await expect(manager.appendModelChange("", "")).rejects.toThrow(
      "Invalid session transcript entry",
    );
    expect(appendState(manager)).toEqual([entriesBefore, null, null]);
  });

  it("uses the selected logical leaf immediately after a side append control", () => {
    const manager = SessionManager.inMemory("/tmp");
    const firstId = manager.appendMessage(makeUserMessage("first", 1));
    const secondId = manager.appendMessage(makeUserMessage("second", 2));
    const control = manager.appendLeafControl({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });

    const thirdId = manager.appendMessage(makeUserMessage("third", 3));

    expect(branchIds(manager)).toEqual([firstId, thirdId]);
    manager.branch(control.id);
    expect(manager.getLeafId()).toBe(firstId);
    expect(() =>
      manager.appendLeafControl({
        targetId: thirdId,
        appendParentId: "missing-parent",
      }),
    ).toThrow("Append parent missing-parent not found");
  });

  it("refreshes cwd when switching persisted targets and rejects identity reset", async () => {
    const { dir, scope: firstTarget } = createScope("first-target");
    const secondTarget = sessionScope(firstTarget.storePath, "second-target");
    await upsertSessionEntryCore(firstTarget, { sessionId: firstTarget.sessionId, updatedAt: 1 });
    await upsertSessionEntryCore(secondTarget, { sessionId: secondTarget.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(firstTarget, {
      cwd: path.join(dir, "first-workspace"),
      message: { role: "user", content: "first" },
    });
    replaceTranscriptEventsSync(secondTarget, [
      null,
      sessionHeader(secondTarget.sessionId, path.join(dir, "second-workspace")),
    ]);

    const manager = SessionManager.open(firstTarget);
    const leaf = manager.getLeafId();
    manager.appendLeafControl({ targetId: leaf, appendParentId: leaf, appendMode: "side" });
    manager.setSessionTarget(secondTarget);
    expect(manager.getAppendMode()).toBeUndefined();

    expect(manager.getCwd()).toBe(path.join(dir, "second-workspace"));
    expect(() => manager.newSession()).toThrow(
      "Persisted session managers cannot change session identity in place",
    );
  });

  it("does not mutate frozen caller entries during in-memory migration", () => {
    const entries = [
      null,
      Object.freeze(sessionHeader("frozen-legacy-session", "/tmp", 2)),
      Object.freeze({
        type: "message" as const,
        id: "frozen-legacy-hook",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: Object.freeze({ role: "hookMessage", content: "frozen hook context" }),
      }),
    ] as const;

    const manager = SessionManager.fromEntries(Object.freeze(entries));

    expect(manager.getEntry("frozen-legacy-hook")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "frozen hook context" },
    });
    expect(entries[2].message).toEqual({
      role: "hookMessage",
      content: "frozen hook context",
    });
  });

  it("keeps stale appenders valid across a reset while snapshot replacement rotates generation", async () => {
    const { dir, scope } = createScope("sqlite-reset-stale-appender");
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      eventId: "initial-user",
      message: { role: "user", content: "before reset" },
      parentId: null,
    });
    const cursor = readTranscriptRawDelta(scope);
    expect(cursor.kind).toBe("page");
    if (cursor.kind !== "page") {
      throw new Error("expected initial raw cursor page");
    }

    const staleManager = openMarker(marker, scope.sessionKey, dir);
    const resetManager = openMarker(marker, scope.sessionKey, dir);
    resetManager.appendResetBoundary("reset");
    expect(() => staleManager.appendMessage(rebaseAssistant("late append"))).not.toThrow();

    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor }).kind).toBe("page");
    const events = await loadTranscriptEvents(scope);
    expect(events.map((event) => (event as { type?: unknown }).type)).toContain("reset");
    const context = JSON.stringify(openMarker(marker, scope.sessionKey, dir).buildSessionContext());
    expect(context).not.toContain("before reset");
    expect(context).toContain("late append");

    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
  });

  it("rejects persistence after the session target rebounds", async () => {
    const { dir, scope } = createScope("sqlite-prompt-release-rebound");
    const sensitivePeer = "+15551234567";
    const replacement = "replacement-session";
    const sessionKey = `agent:main:whatsapp:direct:${sensitivePeer}\n\x1b[31mspoof`;
    scope.sessionKey = sessionKey;
    const { sessionId, storePath } = scope;
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-user",
      message: { role: "user", content: "question", timestamp: 1 },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-assistant",
      message: rebaseAssistant("answer"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: replacement, updatedAt: 20 },
    );

    const expectedCause = {
      actualSessionIdHash: redactIdentifier(replacement),
      agentIdHash: redactIdentifier(scope.agentId),
      code: "session-rebound",
      expectedSessionIdHash: redactIdentifier(sessionId),
      sessionKeyHash: redactIdentifier(sessionKey),
    };
    const captureError = async (run: () => unknown): Promise<unknown> => {
      try {
        await run();
      } catch (error) {
        return error;
      }
      throw new Error("expected rebound transcript persistence to fail");
    };
    const compactionError = await captureError(() =>
      sessionManager.appendCompaction("late summary", assistant.messageId, 42),
    );
    expect(compactionError).toMatchObject({ cause: expectedCause });

    const beforeRejectedAppends = appendState(sessionManager);
    expect(() => sessionManager.branchWithSummary(null, "late summary")).toThrow(
      "entry was not persisted",
    );
    for (const append of [
      () => sessionManager.appendModelChange("openai", "gpt-5.5"),
      () => sessionManager.appendMessage(makeUserMessage("late message", 1)),
    ]) {
      const error = await captureError(append);
      expect(error).toMatchObject({ cause: expectedCause });
      const operatorFacingReason = formatErrorMessage(error);
      for (const hash of Object.values(expectedCause).filter((value) =>
        value.startsWith("sha256:"),
      )) {
        expect(operatorFacingReason).toContain(hash);
      }
      expect(operatorFacingReason).not.toContain(sessionKey);
      expect(operatorFacingReason).not.toContain(sensitivePeer);
      expect(operatorFacingReason).not.toContain("spoof");
      expect(operatorFacingReason).not.toContain(sessionId);
      expect(operatorFacingReason).not.toContain(replacement);
      expect(operatorFacingReason).not.toContain("\n");
      expect(operatorFacingReason).not.toContain("\x1b");
    }
    expect(appendState(sessionManager)).toEqual(beforeRejectedAppends);
  });
});

function rebaseAssistant(text: string, timestamp = 2) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.5",
    timestamp,
  });
}

function nestedTool(timestamp: number) {
  return createNestedToolActivity({
    runId: "prepared-run",
    scopeId: "prepared-scope",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "prepared-message",
    toolName: "message",
    input: { action: "send", message: "Delivered reply" },
    result: { content: [{ type: "text", text: "Sent" }] },
    isError: false,
    startedAt: timestamp,
    timestamp,
  });
}

async function setup(content = "base") {
  const { dir, scope: target } = createScope("rebase");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const persist = (eventId: string, message: unknown, now = 2, parentId?: string | null) =>
    appendTranscriptMessage(target, { eventId, message, now, parentId });
  await persist("base", makeUserMessage(content, 1), 1);
  return {
    dir,
    target,
    persist,
    manager: SessionManager.open(target, dir),
    events: () => loadTranscriptEvents(target),
  };
}

describe("SessionManager stale-parent rebase", () => {
  it("rebases a stale active append and replays its canonical parent", async () => {
    const { target, manager, persist, events } = await setup();
    const { role, content, timestamp } = rebaseAssistant("late");
    await persist("out-of-band", { role, content, timestamp });
    const message = makeUserMessage("next", 3);
    const id = manager.appendMessage(message);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base", parentId: null },
      { id: "out-of-band", parentId: "base" },
      { id, parentId: "out-of-band" },
    ]);
    expect(manager.getEntry(id)?.parentId).toBe("out-of-band");
    expect(branchIds(manager)).toEqual(["base", "out-of-band", id]);
    expect(
      await appendTranscriptMessage(target, {
        appendIntent: "active-branch",
        eventId: id,
        message,
        parentId: "base",
      }),
    ).toMatchObject({ appended: false, effectiveParentId: "out-of-band", messageId: id });
  });

  it("reloads a stale control append after an unchanged-parent prefix rewrite", async () => {
    const { target, manager, events } = await setup("old");
    const records = await events();
    expect(
      replaceTranscriptEventsSync(target, [
        records[0],
        {
          type: "message",
          id: "base",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: makeUserMessage("rewritten", 2),
        },
      ]),
    ).toBe(true);
    const id = await manager.appendModelChange("openai", "gpt-5.6");
    expect(branchIds(manager)).toEqual(["base", id]);
    expect(manager.getEntry("base")).toMatchObject({
      type: "message",
      message: { role: "user", content: "rewritten" },
    });
  });

  it("continues a prepared assistant across a visible context-free command pair without replaying it", async () => {
    const { dir, target, manager, persist, events } = await setup();
    const metadata = { excludeFromContext: true, __openclaw: { contextFreeCommand: true } };
    await persist("status-user", { ...makeUserMessage("/status", 2), ...metadata });
    await persist(
      "status-assistant",
      { ...rebaseAssistant("Worker is running", 3), ...metadata },
      3,
    );
    const continuation = rebaseAssistant("stale reply", 4);
    const id = manager.appendMessage(continuation);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "base" } },
      { id: "status-user", parentId: "base", message: { role: "user", content: "/status" } },
      {
        id: "status-assistant",
        parentId: "status-user",
        message: { role: "assistant", content: [{ type: "text", text: "Worker is running" }] },
      },
      { id, parentId: "status-assistant", message: continuation },
    ]);
    const context = manager.buildSessionContext();
    expect(context.messages).toEqual([makeUserMessage("base", 1), continuation]);
    expect(SessionManager.open(target, dir).buildSessionContext()).toEqual(context);
  });

  it.each([
    { name: "excluded-only", kind: "assistant", metadata: { excludeFromContext: true } },
    {
      name: "marked-only",
      kind: "assistant",
      metadata: { __openclaw: { contextFreeCommand: true } },
    },
    {
      name: "nonboolean-marker",
      kind: "nested-tool",
      metadata: { excludeFromContext: true, __openclaw: { contextFreeCommand: "true" } },
    },
  ])(
    "rejects a stale prepared $kind after a newer user turn ($name)",
    async ({ kind, metadata }) => {
      const { manager, persist, events } = await setup();
      await persist("new-user", { ...makeUserMessage("/status", 2), ...metadata });
      await expectRejectedAppend(manager, events, () =>
        manager.appendMessage(
          kind === "assistant" ? rebaseAssistant("stale reply", 3) : nestedTool(3),
        ),
      );
    },
  );

  it("rejects a stale custom message after a same-turn assistant append", async () => {
    const { manager, persist, events } = await setup();
    await persist("delivered-reply", rebaseAssistant("stale reply"));
    await expectRejectedAppend(manager, events, () =>
      manager.appendMessage({
        role: "custom",
        customType: "extension-input",
        content: "Additional instructions",
        display: true,
        timestamp: 3,
      }),
    );
  });

  it("fences a prepared assistant retry to the snapshot that passed validation", async () => {
    const { target, manager, persist, events } = await setup();
    await persist("intermediate-assistant", rebaseAssistant("late"));
    const beforeBranch = branchIds(manager);
    const { db } = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: resolveSessionTranscriptDatabasePath(target),
    });
    const exec = db.exec.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "exec").mockImplementation((statement) => {
      if (statement === "BEGIN IMMEDIATE" && !injected) {
        injected = true;
        expect(
          appendTranscriptMessageSync(target, {
            appendIntent: "active-branch",
            eventId: "new-user",
            message: makeUserMessage("new", 3),
            now: 3,
          }).ok,
        ).toBe(true);
      }
      return exec(statement);
    });
    try {
      expect(() => manager.appendMessage(rebaseAssistant("stale reply", 4))).toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    } finally {
      spy.mockRestore();
    }
    expect(branchIds(manager)).toEqual(beforeBranch);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base" },
      { id: "intermediate-assistant" },
      { id: "new-user" },
    ]);
  });

  it("rejects a prepared nested tool after a newer user outside the restored active ancestry", async () => {
    const { dir, target, manager: source, events } = await setup();
    const parentId = source.appendMessage(rebaseAssistant("ready"));
    const stale = SessionManager.open(target, dir);
    source.branch("base");
    source.appendMessage(makeUserMessage("side user", 3));
    source.branch(parentId);
    await expectRejectedAppend(stale, events, () => stale.appendMessage(nestedTool(4)));
  });

  it("preserves a stale manager branch when the concurrent tail is unrelated", async () => {
    const { dir, target, persist, events } = await setup("first");
    await persist("first-tail", rebaseAssistant("first"));
    const manager = SessionManager.open(target, dir);
    await persist("second-root", makeUserMessage("second", 3), 3, null);
    const id = manager.appendMessage(makeUserMessage("branch", 4));
    expect(manager.getEntry(id)?.parentId).toBe("first-tail");
    expect(branchIds(manager)).toEqual(["base", "first-tail", id]);
    expect(buildSessionContext(manager.getEntries(), "first-tail").messages).toMatchObject([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ]);
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "first-tail" }));
  });

  it.each(["side", "branch"])("retries a stale %s append at its explicit parent", async (mode) => {
    const { dir, target, manager, persist, events } = await setup();
    if (mode === "side") {
      manager.appendLeafControl({ targetId: "base", appendParentId: "base", appendMode: "side" });
      const reopened = SessionManager.open(target, dir);
      expect([
        reopened.getLeafId(),
        reopened.getAppendParentId(),
        reopened.getAppendMode(),
      ]).toEqual(["base", "base", "side"]);
    } else {
      manager.branch("base");
    }
    await persist("concurrent-tail", rebaseAssistant("concurrent"), 2, "base");
    const id = manager.appendMessage(makeUserMessage(mode, 3));
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "base" }));
    expect(manager.getChildren("base").map((entry) => entry.id)).toEqual(["concurrent-tail", id]);
    if (mode === "side") {
      expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
    }
  });
});
