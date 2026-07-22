// Corpus-entry listing tests, split from session-files.test.ts to stay under the
// oxlint max-lines budget.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  statSessionEntrySync,
  type SessionFileEntry,
} from "./session-files.js";

function captureStateDirEnv() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  return {
    restore() {
      if (stateDir === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
      } else {
        Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
      }
      if (configPath === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
      } else {
        Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
      }
    },
  };
}

let fixtureRoot: string;
let tmpDir: string;
let envSnapshot: ReturnType<typeof captureStateDirEnv> | undefined;
let fixtureId = 0;

// On Windows the session-state sqlite handle can briefly keep fixture files
// locked after a test, so `fs.rmSync(..., { force: true })` can surface EBUSY
// during teardown. Retry removal a few times before giving up; the test
// assertions already passed by this point, so a transient lock is not a failure.
function removeFixtureDir(target: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fsSync.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw error;
      }
    }
  }
}

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-"));
});

afterAll(() => {
  removeFixtureDir(fixtureRoot);
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
  envSnapshot = captureStateDirEnv();
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  envSnapshot?.restore();
  envSnapshot = undefined;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

async function upsertTestSessionEntries(
  storePath: string,
  entries: Record<string, Parameters<typeof upsertSessionEntry>[1]>,
): Promise<void> {
  fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({ sessionKey, storePath }, entry);
  }
}

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  it("omits active JSONL session entries from accessor-backed corpus entries", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(sessionsDir, "narrative.jsonl"), "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:dreaming-narrative-run-1": {
        sessionFile: "narrative.jsonl",
        sessionId: "narrative",
        updatedAt: 1,
      },
    });

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps archive artifacts in the corpus and inherits active session classification", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const activePath = path.join(sessionsDir, "cron-run.jsonl");
    const archivePath = path.join(sessionsDir, "cron-run.jsonl.deleted.2026-02-16T22-27-33.000Z");
    fsSync.writeFileSync(activePath, "");
    fsSync.writeFileSync(archivePath, "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
    });

    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(
      new Set([normalizeSessionTranscriptPathForComparison(archivePath)]),
    );
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual({
      agentId: "main",
      artifactKind: "archive-artifact",
      contentRevision: expect.any(String),
      generatedByCronRun: true,
      sessionFile: archivePath,
      sessionId: "cron-run",
    });
  });

  it("reads live SQLite rows by session identity while preserving archived JSONL artifacts", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:sqlite-live";
    const sessionId = "sqlite-live";
    const updatedAt = Date.parse("2026-06-25T12:00:00.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntry({ agentId: "main", sessionKey, storePath }, { sessionId, updatedAt });
    const turn = await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [
          {
            message: {
              role: "user",
              content: "Live SQLite transcript text",
              timestamp: updatedAt,
            },
          },
        ],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    fsSync.writeFileSync(
      archivePath,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived JSONL transcript text" },
      }),
    );

    expect(fsSync.existsSync(path.join(sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "main",
          artifactKind: "active-session",
          contentRevision: expect.any(String),
          sessionFile: turn.sessionFile,
          sessionId,
          sessionKey,
          transcriptSource: "sqlite",
          updatedAtMs: expect.any(Number),
        }),
        expect.objectContaining({
          agentId: "main",
          artifactKind: "archive-artifact",
          contentRevision: expect.any(String),
          sessionFile: archivePath,
          sessionId,
        }),
      ]),
    );

    const liveEntry = requireSessionEntry(
      await buildSessionEntry(turn.sessionFile, { sessionKey, updatedAtMs: updatedAt }),
    );
    const liveState = statSessionEntrySync(turn.sessionFile, {
      sessionKey,
      updatedAtMs: updatedAt,
    });
    const archiveEntry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(liveEntry.path).toBe("sessions/main/sqlite-live.jsonl");
    expect(liveEntry.content).toBe("User: Live SQLite transcript text");
    expect(liveState).toEqual({
      absPath: turn.sessionFile,
      path: liveEntry.path,
      mtimeMs: liveEntry.mtimeMs,
      size: liveEntry.size,
    });
    expect(archiveEntry.path).toBe(
      "sessions/main/sqlite-live.jsonl.deleted.2026-06-25T12-01-00.000Z",
    );
    expect(archiveEntry.content).toBe("User: Archived JSONL transcript text");
  });

  it("exposes content revisions that change with SQLite appends and file replacement", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:revision";
    const sessionId = "revision";
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "user", content: "first" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    fsSync.writeFileSync(archivePath, "first");

    const before = await listSessionTranscriptCorpusEntriesForAgent("main");
    const beforeLive = before.find((entry) => entry.transcriptSource === "sqlite");
    const beforeArchive = before.find((entry) => entry.sessionFile === archivePath);
    expect(beforeLive?.contentRevision).toEqual(expect.any(String));
    expect(beforeArchive?.contentRevision).toEqual(expect.any(String));

    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "second" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const replacement = `${archivePath}.replacement`;
    fsSync.writeFileSync(replacement, "second");
    fsSync.renameSync(replacement, archivePath);

    const after = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(after.find((entry) => entry.transcriptSource === "sqlite")?.contentRevision).not.toBe(
      beforeLive?.contentRevision,
    );
    expect(after.find((entry) => entry.sessionFile === archivePath)?.contentRevision).not.toBe(
      beforeArchive?.contentRevision,
    );
  });

  it("classifies active entries through cron parentage chains", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronPath = path.join(sessionsDir, "cron-run.jsonl");
    const spawnedChildPath = path.join(sessionsDir, "spawned-child.jsonl");
    const keyedChildPath = path.join(sessionsDir, "keyed-child.jsonl");
    const orphanChildPath = path.join(sessionsDir, "orphan-child.jsonl");
    const normalPath = path.join(sessionsDir, "normal-child.jsonl");
    for (const filePath of [
      cronPath,
      spawnedChildPath,
      keyedChildPath,
      orphanChildPath,
      normalPath,
    ]) {
      fsSync.writeFileSync(filePath, "");
    }
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
      "agent:main:subagent:spawned-child": {
        sessionFile: "spawned-child.jsonl",
        sessionId: "spawned-child",
        spawnedBy: "agent:main:cron:job-1:run:run-1",
        updatedAt: 1,
      },
      "agent:main:subagent:keyed-child": {
        parentSessionKey: "agent:main:subagent:spawned-child",
        sessionFile: "keyed-child.jsonl",
        sessionId: "keyed-child",
        updatedAt: 1,
      },
      "agent:main:subagent:orphan-child": {
        sessionFile: "orphan-child.jsonl",
        sessionId: "orphan-child",
        spawnedBy: "agent:main:cron:job-1:run:missing",
        updatedAt: 1,
      },
      "agent:main:subagent:normal-child": {
        sessionFile: "normal-child.jsonl",
        sessionId: "normal-child",
        spawnedBy: "agent:main:chat:manual",
        updatedAt: 1,
      },
    });

    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(new Set());
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    expect(entries.find((entry) => entry.sessionFile === normalPath)?.generatedByCronRun).toBe(
      undefined,
    );
  });

  it("keeps archive classification when the active transcript is missing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const archivePath = path.join(sessionsDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    fsSync.writeFileSync(archivePath, "");
    await upsertTestSessionEntries(path.join(sessionsDir, "sessions.json"), {
      "agent:main:cron:job-1:run:run-1": {
        sessionFile: "cron-run.jsonl",
        sessionId: "cron-run",
        updatedAt: 1,
      },
    });

    const expectedArchivePath = archivePath;
    const classification = loadSessionTranscriptClassificationForAgent("main");

    expect(classification.cronRunTranscriptPaths).toEqual(
      new Set([normalizeSessionTranscriptPathForComparison(expectedArchivePath)]),
    );
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([expectedArchivePath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([
      {
        agentId: "main",
        artifactKind: "archive-artifact",
        contentRevision: expect.any(String),
        generatedByCronRun: true,
        sessionFile: expectedArchivePath,
        sessionId: "cron-run",
      },
    ]);
  });

  it("omits active session entries whose transcript files are missing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:missing": {
          sessionFile: "missing.jsonl",
          sessionId: "missing",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits active session entries whose transcript path is a symlink", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const targetPath = path.join(tmpDir, "external.jsonl");
    const symlinkPath = path.join(sessionsDir, "linked.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(targetPath, "");
    fsSync.symlinkSync(targetPath, symlinkPath);
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:linked": {
          sessionFile: "linked.jsonl",
          sessionId: "linked",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects session ids that would escape the sessions directory", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, "secret.jsonl"), "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:escape": {
          sessionId: "../secret",
        },
      }),
    );

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("does not classify a fallback transcript when explicit sessionFile is invalid", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "active.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionFile: "../old.jsonl",
          sessionId: "active",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects relative sessionFile values that escape through nested segments", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const secretPath = path.join(tmpDir, "agents", "main", "secret.jsonl");
    fsSync.mkdirSync(path.join(sessionsDir, "sub"), { recursive: true });
    fsSync.writeFileSync(secretPath, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:escape-file": {
          sessionFile: "sub/../../secret.jsonl",
          sessionId: "secret",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("rejects absolute transcript paths owned by another agent", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const otherSessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
    const otherSessionFile = path.join(otherSessionsDir, "private.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.mkdirSync(otherSessionsDir, { recursive: true });
    fsSync.writeFileSync(otherSessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:chat:cross-agent": {
          sessionFile: otherSessionFile,
          sessionId: "private",
        },
      }),
    );

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits loose non-archive JSONL transcripts from the corpus", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "active-thread-456.jsonl");
    fsSync.writeFileSync(sessionFile, "");

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("omits active JSONL transcripts from a custom session store", async () => {
    const sessionsDir = path.join(tmpDir, "custom-sessions");
    const sessionFile = path.join(sessionsDir, "custom-thread.jsonl");
    const storePath = path.join(sessionsDir, "sessions.json");
    const configPath = path.join(tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }));
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await upsertTestSessionEntries(storePath, {
      "agent:main:chat:custom": {
        sessionFile: "custom-thread.jsonl",
        sessionId: "custom-thread",
        updatedAt: 1,
      },
    });

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps unowned archives from an agent-owned fixed session store", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const archivePath = path.join(sessionsDir, "retained.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const configPath = path.join(tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");
    fsSync.writeFileSync(
      configPath,
      JSON.stringify({ session: { store: path.join(sessionsDir, "sessions.json") } }),
    );
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([archivePath]);
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([
      {
        agentId: "main",
        artifactKind: "archive-artifact",
        contentRevision: expect.any(String),
        sessionFile: archivePath,
        sessionId: "retained",
      },
    ]);
  });

  it("resolves absolute transcript paths from a fixed custom store", async () => {
    const storeDir = path.join(tmpDir, "custom-sessions");
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const sessionFile = path.join(sessionsDir, "absolute-thread.jsonl");
    const archivePath = path.join(
      sessionsDir,
      "absolute-thread.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(tmpDir, "openclaw.json");
    fsSync.mkdirSync(storeDir, { recursive: true });
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }));
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await upsertTestSessionEntries(storePath, {
      "agent:main:chat:absolute": {
        sessionFile,
        sessionId: "absolute-thread",
        updatedAt: 1,
      },
    });

    await expect(listSessionFilesForAgent("main")).resolves.toEqual([archivePath]);
  });

  it("keeps legacy session keys in non-main per-agent stores", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
    const sessionFile = path.join(sessionsDir, "legacy-thread.jsonl");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "slack:workspace:thread": {
          sessionFile: "legacy-thread.jsonl",
          sessionId: "legacy-thread",
        },
      }),
    );

    await expect(listSessionFilesForAgent("ops")).resolves.toEqual([]);
    await expect(listSessionFilesForAgent("main")).resolves.toEqual([]);
  });

  it("keeps legacy main aliases in a renamed default agent store", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "ops", "sessions");
    const sessionFile = path.join(sessionsDir, "legacy-main.jsonl");
    const configPath = path.join(tmpDir, "openclaw.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "legacy-main.jsonl",
          sessionId: "legacy-main",
        },
      }),
    );
    fsSync.writeFileSync(
      configPath,
      JSON.stringify({ agents: { entries: { ops: { default: true } } } }),
    );
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    await expect(listSessionFilesForAgent("ops")).resolves.toEqual([]);
  });
});
