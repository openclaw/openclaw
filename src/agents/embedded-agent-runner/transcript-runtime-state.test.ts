import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { SessionEntry, SessionHeader } from "../sessions/index.js";
import {
  deleteRuntimeTranscript,
  readRuntimeTranscriptState,
  runtimeTranscriptExists,
} from "./transcript-runtime-state.js";
import {
  captureSqliteRuntimeCompactionCheckpointSnapshot,
  deleteSqliteRuntimeTranscript,
  persistSqliteRuntimeTranscriptStateMutation,
  readSqliteRuntimeSessionLeafId,
  readSqliteRuntimeTranscriptState,
  replaceSqliteRuntimeTranscriptEntries,
  resolveSqliteRuntimeTranscriptTarget,
  sqliteRuntimeTranscriptExists,
} from "./transcript-runtime-state.sqlite.js";

const TEST_TIMESTAMP_ISO = "2026-01-01T00:00:00.000Z";
const TEST_TIMESTAMP_MS = Date.parse(TEST_TIMESTAMP_ISO);

function createSessionHeader(version = CURRENT_SESSION_VERSION): SessionHeader {
  return {
    type: "session",
    id: "session-1",
    version,
    timestamp: TEST_TIMESTAMP_ISO,
    cwd: "/tmp/openclaw-test",
  };
}

function createUserMessageEntry(params: {
  id: string;
  content: string;
  parentId?: string | null;
}): SessionEntry {
  return {
    type: "message",
    id: params.id,
    message: {
      role: "user",
      content: params.content,
      timestamp: TEST_TIMESTAMP_MS,
    },
    parentId: params.parentId ?? null,
    timestamp: TEST_TIMESTAMP_ISO,
  };
}

describe("runtime transcript state", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and deletes transcript state through runtime scope", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, {
      id: "msg-1",
      message: { role: "user", content: "hello" },
      parentId: null,
      type: "message",
    });

    await expect(runtimeTranscriptExists(scope)).resolves.toBe(true);
    const { state, target } = await readRuntimeTranscriptState(scope);
    expect(fs.realpathSync(target.sessionFile)).toBe(
      fs.realpathSync(path.join(tempDir, "session-1.jsonl")),
    );
    expect(state.getBranch()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: "hello" }),
        type: "message",
      }),
    ]);

    await expect(deleteRuntimeTranscript(scope)).resolves.toBe(true);
    await expect(runtimeTranscriptExists(scope)).resolves.toBe(false);
  });

  it("reads and deletes transcript state through SQLite runtime scope", async () => {
    const sqlitePath = path.join(tempDir, "openclaw-agent.sqlite");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: sqlitePath,
    };
    const target = resolveSqliteRuntimeTranscriptTarget(scope);

    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [createSessionHeader(), createUserMessageEntry({ id: "msg-1", content: "hello" })],
    });

    await expect(sqliteRuntimeTranscriptExists(scope)).resolves.toBe(true);
    const { state } = await readSqliteRuntimeTranscriptState(scope);
    expect(state.getHeader()).toMatchObject({ id: "session-1", type: "session" });
    expect(state.getBranch()).toEqual([
      expect.objectContaining({
        id: "msg-1",
        message: expect.objectContaining({ content: "hello" }),
        type: "message",
      }),
    ]);

    await expect(deleteSqliteRuntimeTranscript(scope)).resolves.toBe(true);
    await expect(sqliteRuntimeTranscriptExists(scope)).resolves.toBe(false);
  });

  it("persists SQLite transcript appends and migrated rewrites", async () => {
    const sqlitePath = path.join(tempDir, "openclaw-agent.sqlite");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: sqlitePath,
    };
    const target = resolveSqliteRuntimeTranscriptTarget(scope);

    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [createSessionHeader(), createUserMessageEntry({ id: "msg-1", content: "hello" })],
    });
    const readBeforeAppend = await readSqliteRuntimeTranscriptState(scope);
    const appended = readBeforeAppend.state.appendMessage({
      role: "user",
      content: "there",
      timestamp: TEST_TIMESTAMP_MS,
    });

    await persistSqliteRuntimeTranscriptStateMutation({
      appendedEntries: [appended],
      state: readBeforeAppend.state,
      target: readBeforeAppend.target,
    });

    await expect(readSqliteRuntimeSessionLeafId(scope)).resolves.toBe(appended.id);
    expect((await readSqliteRuntimeTranscriptState(scope)).state.getBranch()).toEqual([
      expect.objectContaining({ id: "msg-1" }),
      expect.objectContaining({ id: appended.id }),
    ]);

    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [
        createSessionHeader(1),
        createUserMessageEntry({ id: "legacy-msg", content: "legacy" }),
      ],
    });
    const migrated = await readSqliteRuntimeTranscriptState(scope);
    const migratedAppend = migrated.state.appendMessage({
      role: "user",
      content: "migrated",
      timestamp: TEST_TIMESTAMP_MS,
    });

    await persistSqliteRuntimeTranscriptStateMutation({
      appendedEntries: [migratedAppend],
      state: migrated.state,
      target: migrated.target,
    });

    const afterMigration = await readSqliteRuntimeTranscriptState(scope);
    expect(afterMigration.state.getHeader()).toMatchObject({
      id: "session-1",
      version: CURRENT_SESSION_VERSION,
    });
    expect(afterMigration.state.getBranch()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: "legacy" }),
        type: "message",
      }),
      expect.objectContaining({ id: migratedAppend.id }),
    ]);
  });

  it("fully replaces SQLite transcript rows", async () => {
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(tempDir, "openclaw-agent.sqlite"),
    };
    const target = resolveSqliteRuntimeTranscriptTarget(scope);

    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [createSessionHeader(), createUserMessageEntry({ id: "old-msg", content: "old" })],
    });
    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [createSessionHeader(), createUserMessageEntry({ id: "new-msg", content: "new" })],
    });

    expect((await readSqliteRuntimeTranscriptState(scope)).state.getBranch()).toEqual([
      expect.objectContaining({ id: "new-msg" }),
    ]);
  });

  it("reads SQLite checkpoint leaf and snapshot metadata", async () => {
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(tempDir, "openclaw-agent.sqlite"),
    };
    const target = resolveSqliteRuntimeTranscriptTarget(scope);

    await replaceSqliteRuntimeTranscriptEntries({
      target,
      entries: [createSessionHeader(), createUserMessageEntry({ id: "leaf-msg", content: "leaf" })],
    });

    await expect(readSqliteRuntimeSessionLeafId(scope)).resolves.toBe("leaf-msg");
    await expect(captureSqliteRuntimeCompactionCheckpointSnapshot({ scope })).resolves.toEqual({
      leafId: "leaf-msg",
      sessionId: "session-1",
    });
  });
});
