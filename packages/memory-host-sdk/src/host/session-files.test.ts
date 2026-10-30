import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { encodeSessionArchiveContent } from "../../../../src/config/sessions/archive-compression.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../../../src/test-utils/session-state-cleanup.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  statSessionEntry,
  type SessionFileEntry,
} from "./session-files.js";

function clearRuntimeConfig() {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

const listCorpus = () => listSessionTranscriptCorpusEntriesForAgent("main");
const tempDirs = useSessionStoreTempDirs(afterAll, "session-entry-test-");
let tmpDir: string;

beforeEach(() => {
  tmpDir = tempDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", process.env.OPENCLAW_CONFIG_PATH);
  clearRuntimeConfig();
});

afterEach(async () => {
  // Close case databases before restoring its environment or removing its files.
  await cleanupSessionStateForTest({ stateDir: tmpDir, rootPath: tmpDir });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRuntimeConfig();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildEntry(
  filePath: string,
  options?: Parameters<typeof buildSessionEntry>[1],
): Promise<SessionFileEntry> {
  const entry = await buildSessionEntry(filePath, options);
  assert(entry, "expected session entry");
  return entry;
}

function sessionDirectory(relativePath = "agents/main/sessions") {
  const dir = path.join(tmpDir, relativePath);
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRecords(name: string, records: unknown[]) {
  const filePath = path.join(tmpDir, name);
  fsSync.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
  return filePath;
}
function writeMessages(name: string, messages: unknown[]) {
  return writeRecords(
    name,
    messages.map((message) => ({ type: "message", message })),
  );
}

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  beforeEach(async () => {
    await captureRuntimeConfigAsyncReader()();
  });

  it("surfaces unexpected archive-directory scan failures", async () => {
    sessionDirectory();
    const scanError = Object.assign(new Error("transient session archive scan failure"), {
      code: "EIO",
    });
    vi.spyOn(fs, "readdir").mockRejectedValue(scanError);
    await expect(listCorpus()).rejects.toBe(scanError);
  });

  it("reads live SQLite rows by session identity while preserving archived JSONL artifacts", async () => {
    const sessionsDir = sessionDirectory();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:sqlite-live:heartbeat";
    const sessionId = "sqlite-live";
    const sourceText = `API_TOKEN = computeToken() sk-${"a".repeat(48)}`;
    const updatedAt = Date.parse("2026-06-25T12:00:00.000Z");
    const identity = { agentId: "main", sessionId, sessionKey, storePath };

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt },
    );
    await persistSessionTranscriptTurn(identity, {
      messages: [{ message: makeUserMessage(sourceText, updatedAt) }],
      touchSessionEntry: true,
      updateMode: "none",
    });
    const archivePath = path.join(
      sessionsDir,
      `${sessionId}.jsonl.deleted.2026-06-25T12-01-00.000Z`,
    );
    writeMessages(path.relative(tmpDir, archivePath), [
      { role: "user", content: "Archived JSONL transcript text" },
    ]);

    expect(fsSync.existsSync(path.join(sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    const entries = await listCorpus();
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

    const messages: unknown[] = [];
    const sql = observeHostDataSql();
    let liveEntry: SessionFileEntry;
    let liveState: Awaited<ReturnType<typeof statSessionEntry>>;
    try {
      liveEntry = await buildEntry(sessionKey, {
        ...identity,
        updatedAtMs: updatedAt,
        onTranscriptMessage: (message) => messages.push(message),
      });
      liveState = await statSessionEntry(sessionKey, {
        ...identity,
        updatedAtMs: updatedAt,
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(messages).toEqual([expect.objectContaining({ role: "user", content: sourceText })]);
    const archiveEntry = await buildEntry(archivePath);

    expect(liveEntry).toMatchObject({
      path: "sessions/main/sqlite-live.jsonl",
      content: `User: ${sourceText}`,
    });
    expect(liveState).toEqual({
      absPath: sessionKey,
      path: liveEntry.path,
      mtimeMs: liveEntry.mtimeMs,
      revisionMs: liveEntry.revisionMs,
      size: liveEntry.size,
    });
    expect(archiveEntry).toMatchObject({
      path: "sessions/main/sqlite-live.jsonl.deleted.2026-06-25T12-01-00.000Z",
      content: "User: Archived JSONL transcript text",
    });
    await persistSessionTranscriptTurn(identity, {
      messages: [{ message: makeUserMessage("A newer transcript message", updatedAt + 1) }],
      touchSessionEntry: true,
      updateMode: "none",
    });
    const updatedState = await statSessionEntry(sessionKey, identity);
    expect(updatedState?.size).toBeGreaterThan(liveEntry.size);
  });

  it("omits symlinked archive artifacts from the session corpus", async () => {
    const sessionsDir = sessionDirectory();
    const targetPath = path.join(tmpDir, "external.jsonl");
    const symlinkPath = path.join(sessionsDir, "linked.jsonl.deleted.2026-02-16T22-27-33.000Z");
    fsSync.writeFileSync(symlinkPath, "");
    await expect(listCorpus()).resolves.toContainEqual(
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

    await expect(listCorpus()).resolves.toEqual([]);
  });

  it("uses SQLite identity for entries in a custom session store", async () => {
    const sessionsDir = sessionDirectory("custom-sessions");
    const sessionFile = path.join(sessionsDir, "custom-thread.jsonl");
    const storePath = path.join(sessionsDir, "sessions.json");
    const configPath = path.join(tmpDir, "openclaw.json");
    fsSync.writeFileSync(sessionFile, "");
    fsSync.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }));
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfig();
    await captureRuntimeConfigAsyncReader()();
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:chat:custom", storePath },
      {
        sessionFile: "custom-thread.jsonl",
        sessionId: "custom-thread",
        updatedAt: 1,
      },
    );

    await expect(listCorpus()).resolves.toContainEqual(
      expect.objectContaining({
        sessionFile: "agent:main:chat:custom",
        sessionId: "custom-thread",
        transcriptSource: "sqlite",
      }),
    );
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

describe("buildSessionEntry", () => {
  it("preserves the persisted export hash for wrapped Unicode messages", async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      type: "message",
      timestamp: "2026-09-01T00:00:00Z",
      message: {
        role: index % 2 ? "assistant" : "user",
        content: `sample-${index} café 🦞 ordinary text. `.repeat(32).slice(0, 1024),
        __openclaw: { senderIsOwner: true },
      },
    }));
    const filePath = writeRecords("hash-contract.jsonl", records);
    const entry = await buildEntry(filePath, {
      generatedByCronRun: false,
      generatedByDreamingNarrative: false,
      sessionKind: "interactive",
    });
    expect(entry.lineMap).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(entry.hash).toBe("c0c681f57b6caea32f1a6baee132322c0dbc6f93e75656725fe3ef7158f195ae");
  });

  it("indexes usage-counted reset/deleted archives but still skips bak and checkpoint artifacts", async () => {
    for (const [name, expectedContent, expectedLines] of [
      ["ordinary.jsonl.reset.2026-02-16T22-26-33.000Z", "User: Archived hello", [1]],
      ["ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z", "User: Archived hello", [1]],
      ["ordinary.jsonl.bak.2026-02-16T22-28-33.000Z", "", []],
      ["ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl", "", []],
    ] as const) {
      const filePath = writeMessages(name, [{ role: "user", content: "Archived hello" }]);
      const entry = await buildEntry(filePath);
      expect(entry.content).toBe(expectedContent);
      expect(entry.lineMap).toStrictEqual(expectedLines);
    }
  });

  it("does not wipe earlier or later archive messages after a user-authored cron prompt (#98241)", async () => {
    const archivePath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const messages = [
      { role: "user", content: "Remember Atlas." },
      { role: "assistant", content: "Saved Atlas." },
      { role: "user", content: "[cron:daily-digest] why did it fail?" },
      { role: "assistant", content: "Token expired." },
      {
        role: "user",
        content: "Remember Acme.",
      },
      { role: "assistant", content: "Saved Acme." },
    ];
    writeMessages(path.relative(tmpDir, archivePath), messages);
    const entry = await buildEntry(archivePath);
    expect(entry.generatedByCronRun).toBeFalsy();
    expect(entry.content).toBe(
      [
        "User: Remember Atlas.",
        "Assistant: Saved Atlas.",
        "Assistant: Token expired.",
        "User: Remember Acme.",
        "Assistant: Saved Acme.",
      ].join("\n"),
    );
    expect(entry.lineMap).toStrictEqual([1, 2, 4, 5, 6]);
  });

  it("keeps cron-run reset archives opaque when session metadata preserves the cron key", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    writeRecords(path.relative(tmpDir, archivePath), [
      { type: "session-meta", data: { sessionKey: "agent:main:cron:job-1:run:run-1" } },
      {
        type: "message",
        message: { role: "assistant", content: "Internal cron output that must stay out." },
      },
    ]);

    const entry = await buildEntry(archivePath);

    expect(entry).toMatchObject({ content: "", lineMap: [], generatedByCronRun: true });
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

    const entry = await buildEntry(filePath);
    expect({ content: entry.content, lineMap: entry.lineMap }).toStrictEqual({
      content: "User: First\nAssistant: Second",
      lineMap: [3, 5],
    });
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const filePath = writeMessages("enveloped-session-array.jsonl", [
      {
        role: "user",
        content: [
          markInboundContextLabel("Conversation info:"),
          "```json",
          '{"message_id":"msg-100","chat_id":"-100123"}',
          "```",
          "",
          markInboundContextLabel("Sender:"),
          "```json",
          '{"label":"Chris","id":"42"}',
          "```",
          "",
          "Actual user text",
        ].map((text) => ({ type: "text", text })),
      },
    ]);

    const entry = await buildEntry(filePath);
    expect(entry.content).toBe("User: Actual user text");
  });

  it("drops Date-invalid numeric message timestamps", async () => {
    const filePath = writeMessages("invalid-timestamp-session.jsonl", [
      makeUserMessage("Hello", 8_640_000_000_000_001),
    ]);

    const entry = await buildEntry(filePath);
    expect(entry.messageTimestampsMs).toStrictEqual([0]);
  });
});
