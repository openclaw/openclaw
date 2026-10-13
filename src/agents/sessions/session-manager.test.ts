import fs from "node:fs/promises";
import path from "node:path";
import { serialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
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
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
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
  return {
    dir,
    scope: {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(dir, "sessions.json"),
    },
  };
}

function sessionHeader(id: string, cwd: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session" as const, version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

async function openMarker(
  marker: string,
  sessionKey: string,
  cwd: string,
): Promise<SessionManager> {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return await SessionManager.openAsync({ ...target, sessionKey }, cwd);
}

describe("SessionManager.open", () => {
  it("commits ordered metadata and custom messages with Windows environment semantics off-thread", async () => {
    const { dir, scope: target } = createScope("metadata-worker");
    target.storePath = path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, dir);
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
        manager.appendModelChange("test-provider", "test-model"),
        manager.appendThinkingLevelChange("high"),
        manager.appendMessageAsync({
          role: "custom",
          customType: "synthetic-note",
          content: "saved on the canonical worker",
          display: false,
          timestamp: 1,
        }),
      ]);
    } finally {
      sql.restore();
      clone.mockRestore();
    }
    expect(
      sql.queries.filter((query) =>
        /\b(?:transcript_events|transcript_payloads|session_windows|session_nodes)\b|BEGIN\s+IMMEDIATE/i.test(
          query,
        ),
      ),
    ).toEqual([]);
    expect(manager.getEntries()).toMatchObject([
      {
        type: "model_change",
        id: ids[0],
        parentId: null,
        provider: "test-provider",
        modelId: "test-model",
      },
      { type: "thinking_level_change", id: ids[1], parentId: ids[0], thinkingLevel: "high" },
      {
        type: "message",
        id: ids[2],
        parentId: ids[1],
        message: { role: "custom", content: "saved on the canonical worker" },
      },
    ]);
    expect((await SessionManager.openAsync(target, dir)).getEntries()).toEqual(
      manager.getEntries(),
    );
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
  });

  it("opens SQLite markers without creating marker-named files and persists assistant replies", async () => {
    const { dir, scope } = createScope("sqlite-session");
    const marker = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntryCore(scope, {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      message: { role: "user", content: "question" },
    });
    const manager = await openMarker(marker, scope.sessionKey, dir);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { content: "question", role: "user" },
    ]);
    const assistantId = expectDefined(
      await manager.appendMessageAsync(buildAssistantMessage("answer")),
      "Expected appended message",
    );
    const thinkingId = await manager.appendThinkingLevelChange("high");
    const modelId = await manager.appendModelChange("openai", "gpt-5.5");
    const compactionId = await manager.appendCompactionAsync("summary", "assistant-1", 42);
    const resetId = await manager.appendResetBoundaryAsync("new", assistantId);
    expect(manager.getBoundaryCount()).toBe(2);
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toMatchObject([
      { type: "session" },
      { type: "message", message: { content: "question", role: "user" } },
      {
        type: "message",
        id: assistantId,
        parentId: expect.any(String),
        message: { content: [{ type: "text", text: "answer" }], role: "assistant" },
      },
      { type: "thinking_level_change", id: thinkingId, thinkingLevel: "high" },
      { type: "model_change", id: modelId, modelId: "gpt-5.5", provider: "openai" },
      { type: "compaction", id: compactionId, firstKeptEntryId: "assistant-1", summary: "summary" },
      { type: "reset", id: resetId, firstKeptEntryId: assistantId, reason: "new" },
    ]);
    expect((await openMarker(marker, scope.sessionKey, dir)).getEntries()).toEqual(
      manager.getEntries(),
    );
  });

  it("does not overwrite a rebound session row when the first append seeds its header", async () => {
    const { dir, scope } = createScope("sqlite-stale-appender");
    await upsertSessionEntryCore(scope, {
      sessionId: "sqlite-current-owner",
      updatedAt: 456,
      label: "preserved",
    });
    const before = loadSessionEntry(scope);
    const manager = await SessionManager.openAsync(scope, dir);

    await expect(
      manager.appendMessageAsync({ role: "user", content: "stale message", timestamp: 1 }),
    ).rejects.toThrow("Session transcript header was not persisted");
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("rejects invalid entries before mutating in-memory state", async () => {
    const manager = SessionManager.inMemory("/tmp");
    const entriesBefore = manager.getEntries();

    await expect(manager.appendModelChange("", "")).rejects.toThrow(
      "Invalid session transcript entry",
    );
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(manager.getLeafId()).toBeNull();
    expect(manager.getAppendParentId()).toBeNull();
  });

  it("uses the selected logical leaf immediately after a side append control", async () => {
    const manager = SessionManager.inMemory("/tmp");
    const firstId = expectDefined(
      await manager.appendMessageAsync({
        role: "user",
        content: "first",
        timestamp: 1,
      }),
      "Expected appended message",
    );
    const secondId = expectDefined(
      await manager.appendMessageAsync({
        role: "user",
        content: "second",
        timestamp: 2,
      }),
      "Expected appended message",
    );
    const control = await manager.appendLeafControlAsync({
      targetId: firstId,
      appendParentId: secondId,
      appendMode: "side",
    });

    const thirdId = expectDefined(
      await manager.appendMessageAsync({
        role: "user",
        content: "third",
        timestamp: 3,
      }),
      "Expected appended message",
    );

    expect(manager.getBranch().map((entry) => entry.id)).toEqual([firstId, thirdId]);
    await manager.branchAsync(control.id);
    expect(manager.getLeafId()).toBe(firstId);
    await expect(
      manager.appendLeafControlAsync({
        targetId: thirdId,
        appendParentId: "missing-parent",
      }),
    ).rejects.toThrow("Append parent missing-parent not found");
  });

  it("refreshes cwd when switching persisted targets and rejects identity reset", async () => {
    const { dir, scope: firstTarget } = createScope("first-target");
    const secondTarget = {
      ...firstTarget,
      sessionId: "second-target",
      sessionKey: "agent:main:second-target",
    };
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

    const manager = await SessionManager.openAsync(firstTarget);
    const leaf = manager.getLeafId();
    await manager.appendLeafControlAsync({
      targetId: leaf,
      appendParentId: leaf,
      appendMode: "side",
    });
    await manager.setSessionTargetAsync(secondTarget);
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

    const staleManager = await openMarker(marker, scope.sessionKey, dir);
    const resetManager = await openMarker(marker, scope.sessionKey, dir);
    await resetManager.appendResetBoundaryAsync("reset");
    await staleManager.appendMessageAsync(buildAssistantMessage("late append"));

    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor }).kind).toBe("page");
    const events = await loadTranscriptEvents(scope);
    expect(events.map((event) => (event as { type?: unknown }).type)).toContain("reset");
    const context = JSON.stringify(
      (await openMarker(marker, scope.sessionKey, dir)).buildSessionContext(),
    );
    expect(context).not.toContain("before reset");
    expect(context).toContain("late append");

    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(readTranscriptRawDelta(scope, { cursor: cursor.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
  });

  it("reads the latest normalized name even off the selected branch", async () => {
    const manager = SessionManager.inMemory();
    expect(manager.getSessionName()).toBeUndefined();
    const root = expectDefined(
      await manager.appendMessageAsync({ role: "user", content: "root", timestamp: 1 }),
      "Expected appended message",
    );
    await manager.appendSessionInfoAsync("old name");
    await manager.appendSessionInfoAsync("  first\nsecond\r\nthird  ");
    await manager.branchAsync(root);
    expect(manager.getSessionName()).toBe("first second third");
  });

  it("rejects persistence after the session target rebounds", async () => {
    const { dir, scope } = createScope("sqlite-prompt-release-rebound");
    const sensitivePeer = "+15551234567";
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
      message: buildAssistantMessage("answer"),
      parentId: user.messageId,
    });
    const sessionManager = await openMarker(marker, sessionKey, dir);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    const expectedCause = {
      actualSessionIdHash: redactIdentifier("replacement-session"),
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
    const compactionError = await captureError(
      async () =>
        await sessionManager.appendCompactionAsync("late summary", assistant.messageId, 42),
    );
    expect(compactionError).toMatchObject({ cause: expectedCause });

    const entriesBeforeRejectedAppends = sessionManager.getEntries();
    const leafBeforeRejectedAppends = sessionManager.getLeafId();
    const appendParentBeforeRejectedAppends = sessionManager.getAppendParentId();
    await expect(sessionManager.branchWithSummaryAsync(null, "late summary")).rejects.toThrow(
      "entry was not persisted",
    );
    const eventError = await captureError(() =>
      sessionManager.appendModelChange("openai", "gpt-5.5"),
    );
    const messageError = await captureError(async () =>
      expectDefined(
        await sessionManager.appendMessageAsync({
          role: "user",
          content: "late message",
          timestamp: 1,
        }),
        "Expected appended message",
      ),
    );
    for (const error of [eventError, messageError]) {
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
      expect(operatorFacingReason).not.toContain("replacement-session");
      expect(operatorFacingReason).not.toContain("\n");
      expect(operatorFacingReason).not.toContain("\x1b");
    }
    expect(sessionManager.getEntries()).toEqual(entriesBeforeRejectedAppends);
    expect(sessionManager.getLeafId()).toBe(leafBeforeRejectedAppends);
    expect(sessionManager.getAppendParentId()).toBe(appendParentBeforeRejectedAppends);
  });
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

function rebaseAssistant(text: string, timestamp = 2) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai",
    model: "gpt-5.5",
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp,
  };
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
  const dir = tempDirs.make("openclaw-session-manager-");
  const target = {
    agentId: "main",
    sessionId: "rebase",
    sessionKey: "agent:main:rebase",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const persist = (eventId: string, message: unknown, now = 2, parentId?: string | null) =>
    appendTranscriptMessage(target, { eventId, message, now, parentId });
  await persist("base", makeUserMessage(content, 1), 1);
  return {
    dir,
    target,
    persist,
    manager: await SessionManager.openAsync(target, dir),
    events: () => loadTranscriptEvents(target),
  };
}

describe("SessionManager stale-parent rebase", () => {
  it("rebases a stale active append and replays its canonical parent", async () => {
    const { target, manager, persist, events } = await setup();
    const { role, content, timestamp } = rebaseAssistant("late");
    await persist("out-of-band", { role, content, timestamp });
    const message = makeUserMessage("next", 3);
    const id = expectDefined(
      await manager.appendMessageAsync(message),
      "Expected appended message",
    );
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base", parentId: null },
      { id: "out-of-band", parentId: "base" },
      { id, parentId: "out-of-band" },
    ]);
    expect(manager.getEntry(id)?.parentId).toBe("out-of-band");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", "out-of-band", id]);
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
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", id]);
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
    const id = expectDefined(
      await manager.appendMessageAsync(continuation),
      "Expected appended message",
    );
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
    expect(manager.buildSessionContext().messages).toEqual([
      makeUserMessage("base", 1),
      continuation,
    ]);
    expect((await SessionManager.openAsync(target, dir)).buildSessionContext()).toEqual(
      manager.buildSessionContext(),
    );
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
      const beforeBranch = manager.getBranch();
      const beforeEvents = await events();
      await expect(
        manager.appendMessageAsync(
          kind === "assistant" ? rebaseAssistant("stale reply", 3) : nestedTool(3),
        ),
      ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
      expect(manager.getBranch()).toEqual(beforeBranch);
      expect(await events()).toEqual(beforeEvents);
    },
  );

  it("rejects a stale custom message after a same-turn assistant append", async () => {
    const { manager, persist, events } = await setup();
    await persist("delivered-reply", rebaseAssistant("stale reply"));
    const beforeBranch = manager.getBranch();
    const beforeEvents = await events();
    await expect(
      manager.appendMessageAsync({
        role: "custom",
        customType: "extension-input",
        content: "Additional instructions",
        display: true,
        timestamp: 3,
      }),
    ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    expect(manager.getBranch()).toEqual(beforeBranch);
    expect(await events()).toEqual(beforeEvents);
  });

  it("fences a prepared assistant retry to the snapshot that passed validation", async () => {
    const { target, manager, persist, events } = await setup();
    await persist("intermediate-assistant", rebaseAssistant("late"));
    const beforeBranch = manager.getBranch().map((entry) => entry.id);
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    let appends = 0;
    const spy = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation((options, database, assertCurrent, operation, controls) =>
        withWorker(
          options,
          database,
          assertCurrent,
          (worker) =>
            operation({
              execute: async (command, commandOptions) => {
                if (command.type === "session.metadata.append" && ++appends === 2) {
                  expect(
                    appendTranscriptMessageSync(target, {
                      appendIntent: "active-branch",
                      eventId: "new-user",
                      message: makeUserMessage("new", 3),
                      now: 3,
                    }).ok,
                  ).toBe(true);
                }
                return await worker.execute(command, commandOptions);
              },
            }),
          controls,
        ),
      );
    try {
      await expect(manager.appendMessageAsync(rebaseAssistant("stale reply", 4))).rejects.toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    } finally {
      spy.mockRestore();
    }
    expect(appends).toBe(2);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(beforeBranch);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base" },
      { id: "intermediate-assistant" },
      { id: "new-user" },
    ]);
  });

  it("rejects a prepared nested tool after a newer user outside the restored active ancestry", async () => {
    const { dir, target, manager: source, events } = await setup();
    const parentId = expectDefined(
      await source.appendMessageAsync(rebaseAssistant("ready")),
      "Expected appended message",
    );
    const stale = await SessionManager.openAsync(target, dir);
    await source.branchAsync("base");
    await source.appendMessageAsync(makeUserMessage("side user", 3));
    await source.branchAsync(parentId);
    const beforeBranch = stale.getBranch();
    const beforeEvents = await events();
    await expect(stale.appendMessageAsync(nestedTool(4))).rejects.toThrow(
      "SQLite transcript changed while preparing rewrite",
    );
    expect(stale.getBranch()).toEqual(beforeBranch);
    expect(await events()).toEqual(beforeEvents);
  });

  it("preserves a stale manager branch when the concurrent tail is unrelated", async () => {
    const { dir, target, persist, events } = await setup("first");
    await persist("first-tail", rebaseAssistant("first"));
    const manager = await SessionManager.openAsync(target, dir);
    await persist("second-root", makeUserMessage("second", 3), 3, null);
    const id = expectDefined(
      await manager.appendMessageAsync(makeUserMessage("branch", 4)),
      "Expected appended message",
    );
    expect(manager.getEntry(id)?.parentId).toBe("first-tail");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", "first-tail", id]);
    expect(buildSessionContext(manager.getEntries(), "first-tail").messages).toMatchObject([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ]);
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "first-tail" }));
  });

  it("retries a stale side append against its unchanged explicit parent", async () => {
    const { dir, target, manager, persist, events } = await setup();
    await manager.appendLeafControlAsync({
      targetId: "base",
      appendParentId: "base",
      appendMode: "side",
    });
    const reopened = await SessionManager.openAsync(target, dir);
    expect(reopened.getLeafId()).toBe("base");
    expect(reopened.getAppendParentId()).toBe("base");
    expect(reopened.getAppendMode()).toBe("side");
    await persist("concurrent-tail", rebaseAssistant("concurrent"), 2, "base");
    const id = expectDefined(
      await manager.appendMessageAsync(makeUserMessage("side", 3)),
      "Expected appended message",
    );
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "base" }));
    expect(manager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "concurrent-tail" }),
        expect.objectContaining({ id }),
      ]),
    );
    await manager.prepareTranscriptRewriteAsync();
  });

  it("retries a stale deliberate branch against an unchanged explicit parent", async () => {
    const { manager, persist, events } = await setup();
    await manager.branchAsync("base");
    await persist("concurrent-tail", rebaseAssistant("concurrent"), 2, "base");
    const id = expectDefined(
      await manager.appendMessageAsync(makeUserMessage("branch", 3)),
      "Expected appended message",
    );
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "base" }));
    expect(manager.getChildren("base").map((entry) => entry.id)).toEqual(["concurrent-tail", id]);
  });
});
