// Memory Host SDK tests cover session-transcript-corpus eligibility metadata.
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
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
} from "./session-transcript-corpus.js";

function captureStateDirEnv() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  return {
    restore() {
      if (stateDir === undefined) {
        Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
      } else {
        Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
      }
    },
  };
}

let fixtureRoot: string;
let tmpDir: string;
let envSnapshot: ReturnType<typeof captureStateDirEnv> | undefined;
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-transcript-corpus-test-"));
});

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
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

function findEntry(
  entries: SessionTranscriptCorpusEntry[],
  predicate: (e: SessionTranscriptCorpusEntry) => boolean,
): SessionTranscriptCorpusEntry | undefined {
  return entries.find(predicate);
}

describe("SessionTranscriptCorpusEntry eligibleForDreaming", () => {
  it("marks SQLite-backed active sessions as eligible for dreaming", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:corpus-eligible-1";
    const sessionId = "corpus-eligible-1";
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [
          { message: { role: "user", content: "Hello from corpus test", timestamp: Date.now() } },
        ],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    const entry = findEntry(entries, (e) => e.sessionId === sessionId);
    expect(entry).toMatchObject({
      agentId: "main",
      artifactKind: "active-session",
      eligibleForDreaming: true,
      sessionId,
      transcriptSource: "sqlite",
    });
  });

  it("marks deleted archive artifacts as ineligible for dreaming", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    const archivePath = path.join(sessionsDir, "ordinary.jsonl.deleted.2026-04-01T12-00-00.000Z");
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    const entry = findEntry(entries, (e) => e.sessionId === "ordinary");
    expect(entry).toMatchObject({
      agentId: "main",
      artifactKind: "archive-artifact",
      eligibleForDreaming: false,
      sessionId: "ordinary",
    });
  });

  it("marks reset archive artifacts as ineligible for dreaming", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    const archivePath = path.join(sessionsDir, "ordinary.jsonl.reset.2026-04-01T12-00-00.000Z");
    fsSync.writeFileSync(archivePath, "");
    fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    const entry = findEntry(entries, (e) => e.sessionId === "ordinary");
    expect(entry).toMatchObject({
      agentId: "main",
      artifactKind: "archive-artifact",
      eligibleForDreaming: false,
      sessionId: "ordinary",
    });
  });

  it("marks orphaned deleted archive as ineligible for dreaming when no active session exists", async () => {
    // Simulates the reported scenario: deleted archive files with no matching
    // sessions.json entry must not enter the Dreaming corpus.
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    const archivePath = path.join(sessionsDir, "orphaned.jsonl.deleted.2026-04-01T12-00-00.000Z");
    fsSync.writeFileSync(archivePath, "");
    // sessions.json does NOT contain a matching entry for "orphaned"
    fsSync.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    const entry = findEntry(entries, (e) => e.sessionId === "orphaned");
    // Orphaned archive artifact is present in corpus for memory_search but
    // must be excluded from Dreaming ingestion.
    expect(entry).toBeDefined();
    expect(entry?.artifactKind).toBe("archive-artifact");
    expect(entry?.eligibleForDreaming).toBe(false);
  });

  it("marks cron-session archive artifact as ineligible for dreaming while preserving lineage", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    const activePath = path.join(sessionsDir, "cron-run.jsonl");
    const archivePath = path.join(sessionsDir, "cron-run.jsonl.deleted.2026-04-01T12-00-00.000Z");
    fsSync.writeFileSync(activePath, "");
    fsSync.writeFileSync(archivePath, "");
    await upsertSessionEntry(
      { agentId: "main", sessionKey: "agent:main:cron:job-1:run:run-1", storePath },
      { sessionFile: "cron-run.jsonl", sessionId: "cron-run", updatedAt: 1 },
    );

    const entries = await listSessionTranscriptCorpusEntriesForAgent("main");
    const archiveEntry = findEntry(
      entries,
      (e) => e.sessionId === "cron-run" && e.artifactKind === "archive-artifact",
    );
    // Archive inherits cron lineage AND is ineligible for Dreaming.
    expect(archiveEntry).toMatchObject({
      artifactKind: "archive-artifact",
      eligibleForDreaming: false,
      generatedByCronRun: true,
      sessionId: "cron-run",
    });
  });
});
