// Memory Host SDK tests cover transcript classification behavior.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSessionTranscriptClassificationForSessionsDir } from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-classification-test-"));
});

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
});

function writeSessionStore(
  sessionsDir: string,
  store: Record<string, Record<string, unknown>>,
): void {
  fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(store));
}

describe("loadSessionTranscriptClassificationForSessionsDir", () => {
  it("classifies a session with direct cron key as cron-run", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "cron-run.jsonl");
    fsSync.writeFileSync(sessionFile, JSON.stringify({ type: "message", message: {} }));
    writeSessionStore(sessionsDir, {
      "agent:main:cron:job-1:run:run-1": { sessionFile },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect([...result.cronRunTranscriptPaths]).toEqual([sessionFile]);
    expect(result.dreamingNarrativeTranscriptPaths.size).toBe(0);
  });

  it("classifies a subagent via spawnedBy chain to a cron parent", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronSession = path.join(sessionsDir, "cron-run.jsonl");
    const subSession = path.join(sessionsDir, "sub-agent.jsonl");
    fsSync.writeFileSync(cronSession, "");
    fsSync.writeFileSync(subSession, "");
    writeSessionStore(sessionsDir, {
      "agent:main:cron:job-1:run:run-1": { sessionFile: cronSession },
      "agent:main:subagent:uuid-1": {
        sessionFile: subSession,
        spawnedBy: "agent:main:cron:job-1:run:run-1",
      },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(2);
  });

  it("classifies a deeply nested subagent chain as cron-run", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronSession = path.join(sessionsDir, "cron-run.jsonl");
    const sub1Session = path.join(sessionsDir, "sub-1.jsonl");
    const sub2Session = path.join(sessionsDir, "sub-2.jsonl");
    for (const filePath of [cronSession, sub1Session, sub2Session]) {
      fsSync.writeFileSync(filePath, "");
    }
    writeSessionStore(sessionsDir, {
      "agent:main:cron:job-1:run:run-1": { sessionFile: cronSession },
      "agent:main:subagent:uuid-1": {
        sessionFile: sub1Session,
        spawnedBy: "agent:main:cron:job-1:run:run-1",
      },
      "agent:main:subagent:uuid-2": {
        sessionFile: sub2Session,
        spawnedBy: "agent:main:subagent:uuid-1",
      },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(3);
  });

  it("classifies parentSessionKey descendants of a cron parent", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronSession = path.join(sessionsDir, "cron-run.jsonl");
    const childSession = path.join(sessionsDir, "child.jsonl");
    const grandchildSession = path.join(sessionsDir, "grandchild.jsonl");
    for (const filePath of [cronSession, childSession, grandchildSession]) {
      fsSync.writeFileSync(filePath, "");
    }
    writeSessionStore(sessionsDir, {
      "agent:main:cron:job-1:run:run-1": { sessionFile: cronSession },
      "agent:main:child:one": {
        parentSessionKey: "agent:main:cron:job-1:run:run-1",
        sessionFile: childSession,
      },
      "agent:main:child:two": {
        parentSessionKey: "agent:main:child:one",
        sessionFile: grandchildSession,
      },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths).toEqual(
      new Set([cronSession, childSession, grandchildSession]),
    );
  });

  it("does not classify a normal subagent with no cron ancestry", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "normal.jsonl");
    fsSync.writeFileSync(sessionFile, "");
    writeSessionStore(sessionsDir, {
      "agent:main:subagent:uuid-1": { sessionFile },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(0);
  });

  it("classifies a subagent when spawnedBy is a cron-run key without parent entry", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const subSession = path.join(sessionsDir, "orphan-sub.jsonl");
    fsSync.writeFileSync(subSession, "");
    writeSessionStore(sessionsDir, {
      "agent:main:subagent:orphan-uuid": {
        sessionFile: subSession,
        spawnedBy: "agent:main:cron:job-1:run:run-42",
      },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(1);
    expect(result.dreamingNarrativeTranscriptPaths.size).toBe(0);
  });

  it("handles cycles in spawnedBy chain without infinite loop", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "cyclic.jsonl");
    fsSync.writeFileSync(sessionFile, "");
    writeSessionStore(sessionsDir, {
      "agent:main:subagent:uuid-a": {
        sessionFile,
        spawnedBy: "agent:main:subagent:uuid-b",
      },
      "agent:main:subagent:uuid-b": {
        spawnedBy: "agent:main:subagent:uuid-a",
      },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(0);
  });

  it("returns empty classification when no sessions.json exists", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(result.cronRunTranscriptPaths.size).toBe(0);
    expect(result.dreamingNarrativeTranscriptPaths.size).toBe(0);
  });

  it("classifies a dreaming narrative session key", () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "dreaming.jsonl");
    fsSync.writeFileSync(sessionFile, "");
    writeSessionStore(sessionsDir, {
      "agent:main:dreaming-narrative-run-42": { sessionFile },
    });

    const result = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect([...result.dreamingNarrativeTranscriptPaths]).toEqual([sessionFile]);
    expect(result.cronRunTranscriptPaths.size).toBe(0);
  });
});
