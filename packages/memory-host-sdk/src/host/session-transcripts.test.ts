import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  replaceSqliteSessionTranscriptEvents,
} from "./openclaw-runtime-session.js";
import {
  buildSessionTranscriptEntry,
  createSqliteSessionTranscriptRef,
  listSessionTranscriptsForAgent,
  readSessionTranscriptDeltaStats,
  sessionPathForTranscript,
  type SessionTranscriptEntry,
} from "./session-transcripts.js";

let fixtureRoot: string;
let tmpDir: string;
let originalStateDir: string | undefined;
let fixtureId = 0;

function sqliteTranscriptLocator(agentId: string, sessionId: string): string {
  return createSqliteSessionTranscriptRef({ agentId, sessionId });
}

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-entry-test-"));
});

afterAll(() => {
  fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  fsSync.mkdirSync(tmpDir, { recursive: true });
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

function requireSessionTranscriptEntry(
  entry: SessionTranscriptEntry | null,
): SessionTranscriptEntry {
  expect(entry).toBeTruthy();
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

function seedTranscript(params: {
  agentId?: string;
  sessionId: string;
  transcriptPath?: string;
  events: unknown[];
  rememberPath?: boolean;
  now?: number;
}): string {
  const agentId = params.agentId ?? "main";
  const transcriptPath = params.transcriptPath;
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId: params.sessionId,
    ...(params.rememberPath === false || !transcriptPath ? {} : { transcriptPath }),
    events: params.events,
    now: () => params.now ?? 1_770_000_000_000,
  });
  return sqliteTranscriptLocator(agentId, params.sessionId);
}

describe("listSessionTranscriptsForAgent", () => {
  it("lists SQLite transcript handles for an agent", async () => {
    const includedPath = seedTranscript({
      sessionId: "active",
      events: [{ type: "session", id: "active" }],
    });
    seedTranscript({
      agentId: "other",
      sessionId: "other-active",
      events: [{ type: "session", id: "other-active" }],
    });

    const files = await listSessionTranscriptsForAgent("main");

    expect(files).toEqual([includedPath]);
  });

  it("uses a virtual SQLite locator when no legacy transcript path is recorded", async () => {
    seedTranscript({
      sessionId: "sqlite-only",
      events: [{ type: "message", message: { role: "user", content: "Stored only in SQLite" } }],
      rememberPath: false,
    });

    const files = await listSessionTranscriptsForAgent("main");
    const [locator] = files;

    expect(locator).toBe("sqlite-transcript://main/sqlite-only.jsonl");
    const entry = await buildSessionTranscriptEntry(locator);
    expect(entry?.content).toBe("User: Stored only in SQLite");
    expect(entry?.path).toBe("sessions/main/sqlite-only.jsonl");
  });

  it("ignores remembered legacy transcript paths when listing active SQLite transcripts", async () => {
    const legacyPath = path.join(tmpDir, "agents", "main", "sessions", "remembered.jsonl");
    seedTranscript({
      sessionId: "remembered",
      transcriptPath: legacyPath,
      events: [{ type: "message", message: { role: "user", content: "remembered path" } }],
    });

    await expect(listSessionTranscriptsForAgent("main")).resolves.toEqual([
      "sqlite-transcript://main/remembered.jsonl",
    ]);
  });
});

describe("sessionPathForTranscript", () => {
  it("formats canonical SQLite locators as stable session export paths", () => {
    expect(
      sessionPathForTranscript(
        createSqliteSessionTranscriptRef({ agentId: "main", sessionId: "active-session" }),
      ),
    ).toBe("sessions/main/active-session.jsonl");
  });

  it("does not preserve legacy filesystem paths as session export identity", () => {
    expect(sessionPathForTranscript(path.join(tmpDir, "loose-session.jsonl"))).toBe(
      "sessions/unknown.jsonl",
    );
  });
});

describe("buildSessionTranscriptEntry", () => {
  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real transcript event stream with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const events = [
      { type: "custom", customType: "model-snapshot", data: {} },
      { type: "custom", customType: "openclaw.cache-ttl", data: {} },
      { type: "session-meta", agentId: "test" },
      { type: "message", message: { role: "user", content: "Hello world" } },
      { type: "custom", customType: "tool-result", data: {} },
      {
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      },
      { type: "message", message: { role: "user", content: "Tell me a joke" } },
    ];
    const filePath = seedTranscript({ sessionId: "session", events });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(filePath));
    expect(entry.messageCount).toBe(7);

    // The content should have 3 lines (3 message records)
    const contentLines = entry.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const filePath = seedTranscript({
      sessionId: "empty-session",
      events: [
        { type: "custom", customType: "model-snapshot", data: {} },
        { type: "session-meta", agentId: "test" },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(filePath));
    expect(entry.content).toBe("");
    expect(entry.lineMap).toEqual([]);
  });

  it("skips checkpoint artifacts so snapshots do not double-index session content", async () => {
    const checkpointPath = path.join(
      tmpDir,
      "agents",
      "main",
      "sessions",
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    seedTranscript({
      sessionId: "ordinary.checkpoint.11111111-1111-4111-8111-111111111111",
      transcriptPath: checkpointPath,
      events: [
        {
          type: "message",
          message: { role: "user", content: "Archived hello" },
        },
      ],
    });

    await expect(buildSessionTranscriptEntry(checkpointPath)).resolves.toBeNull();
  });

  it("keeps cron-run deleted archives opaque when the live session store entry is gone", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const transcriptRef = seedTranscript({
      sessionId: "cron-run-deleted",
      transcriptPath: archivePath,
      events: [
        {
          type: "message",
          message: {
            role: "user",
            content: "[cron:job-1 Codex Sessions Sync] Run internal sync.",
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: "Internal cron output that must stay out." },
        },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(transcriptRef));

    expect(entry.content).toBe("");
    expect(entry.lineMap).toEqual([]);
    expect(entry.generatedByCronRun).toBe(true);
  });

  it("keeps cron-run reset archives opaque when session metadata preserves the cron key", async () => {
    const archivePath = path.join(tmpDir, "cron-run.jsonl.reset.2026-02-16T22-26-33.000Z");
    const transcriptRef = seedTranscript({
      sessionId: "cron-run-reset",
      transcriptPath: archivePath,
      events: [
        {
          type: "session-meta",
          data: { sessionKey: "agent:main:cron:job-1:run:run-1" },
        },
        {
          type: "message",
          message: { role: "assistant", content: "Internal cron output that must stay out." },
        },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(transcriptRef));

    expect(entry.content).toBe("");
    expect(entry.lineMap).toEqual([]);
    expect(entry.generatedByCronRun).toBe(true);
  });

  it("skips non-message events without breaking lineMap", async () => {
    const filePath = seedTranscript({
      sessionId: "gaps",
      events: [
        { type: "custom", customType: "ignored" },
        { type: "message", message: { role: "user", content: "First" } },
        { type: "custom", customType: "ignored-again" },
        { type: "message", message: { role: "assistant", content: "Second" } },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(filePath));
    expect(entry.lineMap).toEqual([2, 4]);
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const filePath = seedTranscript({
      sessionId: "enveloped-session-array",
      events: [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Conversation info (untrusted metadata):" },
              { type: "text", text: "```json" },
              { type: "text", text: '{"message_id":"msg-100","chat_id":"-100123"}' },
              { type: "text", text: "```" },
              { type: "text", text: "" },
              { type: "text", text: "Sender (untrusted metadata):" },
              { type: "text", text: "```json" },
              { type: "text", text: '{"label":"Chris","id":"42"}' },
              { type: "text", text: "```" },
              { type: "text", text: "" },
              { type: "text", text: "Actual user text" },
            ],
          },
        },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(filePath));
    expect(entry.content).toBe("User: Actual user text");
  });

  it("skips inter-session user messages", async () => {
    const filePath = seedTranscript({
      sessionId: "inter-session-session",
      events: [
        {
          type: "message",
          message: {
            role: "user",
            content: "A background task completed. Internal relay text.",
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: "User-facing summary." },
        },
        {
          type: "message",
          message: { role: "user", content: "Actual user follow-up." },
        },
      ],
    });

    const entry = requireSessionTranscriptEntry(await buildSessionTranscriptEntry(filePath));
    expect(entry.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry.lineMap).toEqual([2, 3]);
  });

  it("returns SQLite transcript delta stats without reading a transcript file", () => {
    const filePath = seedTranscript({
      sessionId: "delta-session",
      events: [
        { type: "message", message: { role: "user", content: "First" } },
        { type: "custom", customType: "ignored" },
        { type: "message", message: { role: "assistant", content: "Second" } },
      ],
      now: 1_770_000_000_123,
    });

    const stats = readSessionTranscriptDeltaStats(filePath);

    expect(stats).not.toBeNull();
    expect(stats!.messageCount).toBe(3);
    expect(stats!.updatedAt).toBeGreaterThan(0);
    expect(stats!.size).toBeGreaterThan(0);
  });
});
