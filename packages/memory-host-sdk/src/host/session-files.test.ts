// Memory Host SDK tests cover session files behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { encodeSessionArchiveContent } from "../../../../src/config/sessions/archive-compression.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../../../src/state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../../../src/test-utils/session-state-cleanup.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  statSessionEntrySync,
  type SessionFileEntry,
} from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let envSnapshot: Record<string, string | undefined> | undefined;
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fsSync.realpathSync.native(
    fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-")),
  );
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
  envSnapshot = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  };
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(async () => {
  // Close case databases before restoring its environment or removing its files.
  await cleanupSessionStateForTest({ stateDir: tmpDir, rootPath: tmpDir });
  for (const [key, value] of Object.entries(envSnapshot ?? {})) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
  envSnapshot = undefined;
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

async function upsertTestSessionEntries(
  storePath: string,
  entries: Record<string, Parameters<typeof upsertSessionEntryCore>[1]>,
): Promise<void> {
  fsSync.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntryCore({ sessionKey, storePath }, entry);
  }
}

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  it("surfaces unexpected archive-directory scan failures", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const scanError = Object.assign(new Error("transient session archive scan failure"), {
      code: "EIO",
    });
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async () => {
      throw scanError;
    });

    try {
      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).rejects.toBe(scanError);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("reads live SQLite rows by session identity while preserving archived JSONL artifacts", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:sqlite-live:heartbeat";
    const sessionId = "sqlite-live";
    const updatedAt = Date.parse("2026-06-25T12:00:00.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt },
    );
    await persistSessionTranscriptTurn(
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
          sessionFile: sessionKey,
          sessionId,
          sessionKey,
          transcriptSource: "sqlite",
          updatedAtMs: expect.any(Number),
          sessionKind: "interactive",
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
      await buildSessionEntry(sessionKey, {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
        updatedAtMs: updatedAt,
      }),
    );
    const liveState = statSessionEntrySync(sessionKey, {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      updatedAtMs: updatedAt,
    });
    const archiveEntry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(liveEntry.path).toBe("sessions/main/sqlite-live.jsonl");
    expect(liveEntry.content).toBe("User: Live SQLite transcript text");
    expect(liveState).toEqual({
      absPath: sessionKey,
      path: liveEntry.path,
      mtimeMs: liveEntry.mtimeMs,
      revisionMs: liveEntry.revisionMs,
      size: liveEntry.size,
    });
    expect(archiveEntry.path).toBe(
      "sessions/main/sqlite-live.jsonl.deleted.2026-06-25T12-01-00.000Z",
    );
    expect(archiveEntry.content).toBe("User: Archived JSONL transcript text");
  });

  it("omits symlinked archive artifacts from the session corpus", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const targetPath = path.join(tmpDir, "external.jsonl");
    const symlinkPath = path.join(sessionsDir, "linked.jsonl.deleted.2026-02-16T22-27-33.000Z");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    fsSync.writeFileSync(symlinkPath, "");
    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
      expect.objectContaining({
        artifactKind: "archive-artifact",
        sessionFile: symlinkPath,
        sessionId: "linked",
      }),
    );
    fsSync.unlinkSync(symlinkPath);

    if (process.platform === "win32") {
      fsSync.mkdirSync(targetPath);
      fsSync.symlinkSync(targetPath, symlinkPath, "junction");
    } else {
      fsSync.writeFileSync(targetPath, "");
      fsSync.symlinkSync(targetPath, symlinkPath);
    }
    expect(fsSync.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toEqual([]);
  });

  it("uses SQLite identity for entries in a custom session store", async () => {
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

    await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
      expect.objectContaining({
        sessionFile: "agent:main:chat:custom",
        sessionId: "custom-thread",
        transcriptSource: "sqlite",
      }),
    );
  });
});

describe("memory session sync targets", () => {
  it("parses deprecated canonical OpenClaw transcript paths into sync identity", () => {
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "active.jsonl");
    fsSync.mkdirSync(path.dirname(sessionFile), { recursive: true });

    expect(parseCanonicalSessionSyncTargetFromPath(sessionFile)).toEqual({
      agentId: "main",
      sessionId: "active",
    });
  });

  it("rejects arbitrary deprecated transcript path hints", () => {
    expect(parseCanonicalSessionSyncTargetFromPath(path.join(tmpDir, "active.jsonl"))).toBeNull();
    expect(
      parseCanonicalSessionSyncTargetFromPath(
        path.join(tmpDir, "agents", "main", "sessions", "active.trajectory.jsonl"),
      ),
    ).toBeNull();
  });
});

describe("buildSessionEntry", () => {
  it("preserves the persisted export hash for wrapped Unicode messages", async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      type: "message",
      id: `m${index}`,
      timestamp: "2026-09-01T00:00:00Z",
      message: {
        role: index % 2 ? "assistant" : "user",
        content: `sample-${index} café 🦞 ordinary text. `.repeat(32).slice(0, 1024),
        __openclaw: { senderIsOwner: true },
      },
    }));
    const filePath = path.join(tmpDir, "hash-contract.jsonl");
    fsSync.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
    const entry = requireSessionEntry(
      await buildSessionEntry(filePath, {
        generatedByCronRun: false,
        generatedByDreamingNarrative: false,
        sessionKind: "interactive",
      }),
    );
    expect(entry.lineMap).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(entry.hash).toBe("c0c681f57b6caea32f1a6baee132322c0dbc6f93e75656725fe3ef7158f195ae");
  });

  it("returns lineMap tracking original JSONL line numbers", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe(
      "User: Hello world\nAssistant: Hi there, how can I help?\nUser: Tell me a joke",
    );

    expect(entry.lineMap).toStrictEqual([4, 6, 7]);
  });

  it("indexes usage-counted reset/deleted archives but still skips bak and checkpoint artifacts", async () => {
    const resetPath = path.join(tmpDir, "ordinary.jsonl.reset.2026-02-16T22-26-33.000Z");
    const deletedPath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const bakPath = path.join(tmpDir, "ordinary.jsonl.bak.2026-02-16T22-28-33.000Z");
    const checkpointPath = path.join(
      tmpDir,
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    const content = JSON.stringify({
      type: "message",
      message: { role: "user", content: "Archived hello" },
    });
    fsSync.writeFileSync(resetPath, content);
    fsSync.writeFileSync(deletedPath, content);
    fsSync.writeFileSync(bakPath, content);
    fsSync.writeFileSync(checkpointPath, content);

    const resetEntry = requireSessionEntry(await buildSessionEntry(resetPath));
    const deletedEntry = requireSessionEntry(await buildSessionEntry(deletedPath));
    const bakEntry = requireSessionEntry(await buildSessionEntry(bakPath));
    const checkpointEntry = requireSessionEntry(await buildSessionEntry(checkpointPath));

    // Usage-counted archives (reset, deleted) must surface real content so
    // post-reset memory_search can recover prior session history.
    expect(resetEntry.content).toBe("User: Archived hello");
    expect(resetEntry.lineMap).toStrictEqual([1]);
    expect(deletedEntry.content).toBe("User: Archived hello");
    expect(deletedEntry.lineMap).toStrictEqual([1]);

    // .bak and compaction checkpoints remain opaque pre-archive / snapshot
    // artifacts and stay empty so they do not get double-indexed.
    expect(bakEntry.content).toBe("");
    expect(bakEntry.lineMap).toStrictEqual([]);
    expect(checkpointEntry.content).toBe("");
    expect(checkpointEntry.lineMap).toStrictEqual([]);
  });

  it("does not wipe earlier or later archive messages after a user-authored cron prompt (#98241)", async () => {
    const archivePath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const messages = [
      { role: "user", content: "Remember before: project codename is Atlas." },
      { role: "assistant", content: "Saved project codename Atlas." },
      { role: "user", content: "[cron:daily-digest] why did my digest job fail last night?" },
      { role: "assistant", content: "The digest job failed because the API token expired." },
      {
        role: "user",
        content: "Please remember: my preferred vendor is Acme Robotics and budget is 5000 USD.",
      },
      { role: "assistant", content: "Noted. Acme Robotics, budget 5000 USD." },
    ];
    fsSync.writeFileSync(
      archivePath,
      messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"),
    );
    const entry = requireSessionEntry(await buildSessionEntry(archivePath));
    expect(entry.generatedByCronRun).toBeFalsy();
    expect(entry.content).toBe(
      [
        "User: Remember before: project codename is Atlas.",
        "Assistant: Saved project codename Atlas.",
        "Assistant: The digest job failed because the API token expired.",
        "User: Please remember: my preferred vendor is Acme Robotics and budget is 5000 USD.",
        "Assistant: Noted. Acme Robotics, budget 5000 USD.",
      ].join("\n"),
    );
    expect(entry.lineMap).toStrictEqual([1, 2, 4, 5, 6]);
  });

  it("keeps cron-run reset archives opaque when session metadata preserves the cron key", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    const jsonlLines = [
      JSON.stringify({
        type: "session-meta",
        data: { sessionKey: "agent:main:cron:job-1:run:run-1" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Internal cron output that must stay out." },
      }),
    ];
    fsSync.writeFileSync(archivePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(archivePath));

    expect(entry.content).toBe("");
    expect(entry.lineMap).toStrictEqual([]);
    expect(entry.generatedByCronRun).toBe(true);
  });

  it("preserves blank/malformed compressed archive line ordinals", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
      "",
    ];
    const raw = jsonlLines.join("\n");
    const encoded = encodeSessionArchiveContent(raw);
    const filePath = path.join(
      tmpDir,
      `gaps.jsonl.reset.2026-07-01T10-00-00.000Z${encoded.suffix}`,
    );
    fsSync.writeFileSync(filePath, encoded.bytes);

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("User: First\nAssistant: Second");
    expect(entry.lineMap).toStrictEqual([3, 5]);
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: markInboundContextLabel("Conversation info:") },
            { type: "text", text: "```json" },
            { type: "text", text: '{"message_id":"msg-100","chat_id":"-100123"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: markInboundContextLabel("Sender:") },
            { type: "text", text: "```json" },
            { type: "text", text: '{"label":"Chris","id":"42"}' },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: "Actual user text" },
          ],
        },
      }),
    ];
    const filePath = path.join(tmpDir, "enveloped-session-array.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.content).toBe("User: Actual user text");
  });

  it("drops Date-invalid numeric message timestamps", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: makeUserMessage("Hello", 8_640_000_000_000_001),
      }),
    ];
    const filePath = path.join(tmpDir, "invalid-timestamp-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = requireSessionEntry(await buildSessionEntry(filePath));
    expect(entry.messageTimestampsMs).toStrictEqual([0]);
  });
});
