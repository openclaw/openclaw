// Memory Core tests cover dreaming repair plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendSqliteTranscriptMessage } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const tempDirs: string[] = [];

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-repair-test-"));
  tempDirs.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  return workspaceDir;
}

function requireArchiveDir(archiveDir: string | undefined): string {
  if (!archiveDir) {
    throw new Error("Expected dreaming repair to create an archive directory");
  }
  return archiveDir;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.access(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("dreaming artifact repair", () => {
  it("detects self-ingested dreaming corpus lines", async () => {
    const workspaceDir = await createWorkspace();
    await fs
      .writeFile(
        path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
        [
          "[main/dreaming-main.jsonl#L4] regular session text",
          "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
        ].join("\n"),
        "utf-8",
      )
      .catch(async () => {
        await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
          [
            "[main/dreaming-main.jsonl#L4] regular session text",
            "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
          ].join("\n"),
          "utf-8",
        );
      });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusLineCount).toBe(1);
    expect(audit.issues).toStrictEqual([
      {
        severity: "warn",
        code: "dreaming-session-corpus-self-ingested",
        message:
          "Dreaming session corpus appears to contain self-ingested narrative content (1 suspicious line).",
        fixable: true,
      },
    ]);
  });

  it("does not flag ordinary transcript text that merely mentions dreaming-narrative", async () => {
    const workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
      [
        "[main/chat.jsonl#L4] regular session text",
        "[main/chat.jsonl#L5] We should inspect the dreaming-narrative session behavior tomorrow.",
      ].join("\n"),
      "utf-8",
    );

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.suspiciousSessionCorpusFileCount).toBe(0);
    expect(audit.suspiciousSessionCorpusLineCount).toBe(0);
    expect(audit.issues).toStrictEqual([]);
  });

  it("detects heartbeat-derived corpus lines by source references", async () => {
    const workspaceDir = await createWorkspace();
    const sessionPath = path.join(
      workspaceDir,
      "..",
      "agents",
      "main",
      "sessions",
      "heartbeat-session.jsonl",
    );
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "[OpenClaw heartbeat poll]" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Heartbeat received. Main is active." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
      [
        "[main/sessions/heartbeat-session.jsonl#L2] Heartbeat received. Main is active.",
        "[main/sessions/heartbeat-session.jsonl#L1] [OpenClaw heartbeat poll]",
      ].join("\n"),
      "utf-8",
    );

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.heartbeatContaminatedSessionCorpusFileCount).toBe(1);
    expect(audit.heartbeatContaminatedSessionCorpusLineCount).toBe(1);
    expect(
      audit.issues.some((issue) => issue.code === "dreaming-session-corpus-heartbeat-derived"),
    ).toBe(true);
  });

  it("rejects relative workspace paths during audit and repair", async () => {
    await expect(auditDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
    await expect(repairDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
  });

  it("archives derived dreaming artifacts without touching the diary by default", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionCorpusDir, "2026-04-11.txt"),
      "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
      JSON.stringify({ version: 3, files: {}, seenMessages: {} }, null, 2),
      "utf-8",
    );
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Dream Diary\n", "utf-8");

    const repair = await repairDreamingArtifacts({
      workspaceDir,
      now: new Date("2026-04-11T21:30:00.000Z"),
    });

    expect(repair.changed).toBe(true);
    expect(repair.archivedSessionCorpus).toBe(true);
    expect(repair.archivedSessionIngestion).toBe(true);
    expect(repair.archivedDreamsDiary).toBe(false);
    expect(repair.removedHeartbeatDerivedLines).toBeUndefined();
    expect(repair.clearedSessionCheckpointKeys).toBeUndefined();
    const archiveDir = requireArchiveDir(repair.archiveDir);
    expect(archiveDir).toBe(
      path.join(workspaceDir, ".openclaw-repair", "dreaming", "2026-04-11T21-30-00-000Z"),
    );
    await expectPathMissing(sessionCorpusDir);
    await expectPathMissing(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"));
    await expect(fs.readFile(dreamsPath, "utf-8")).resolves.toContain("# Dream Diary");
    const archivedEntries = await fs.readdir(archiveDir);
    expect(archivedEntries.filter((entry) => entry.startsWith("session-corpus."))).not.toEqual([]);
    expect(
      archivedEntries.filter((entry) => entry.startsWith("session-ingestion.json.")),
    ).not.toEqual([]);
  });

  it("clears sqlite session ingestion state when archiving session corpus", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionCorpusDir, "2026-04-11.txt"),
      "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:\n",
      "utf-8",
    );
    await Promise.all([
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main/session.jsonl",
            value: {
              lastSize: 120,
              lastMtimeMs: 1_000,
              lastContentHash: "hash",
              cursorLine: 42,
            },
          },
        ],
      }),
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main:0",
            value: { scope: "main", index: 0, hashes: ["message-hash"] },
          },
        ],
      }),
    ]);

    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(true);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(true);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      auditDreamingArtifacts({ workspaceDir }).then((audit) => audit.sessionIngestionExists),
    ).resolves.toBe(false);
  });

  it("preserves sqlite daily ingestion state when archiving session corpus", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionCorpusDir, "2026-04-11.txt"),
      "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:\n",
      "utf-8",
    );
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "2026-06-10",
          value: { ingestedAt: 1_000, lastDreamingDayIngested: "2026-06-10" },
        },
      ],
    });

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.archivedSessionCorpus).toBe(true);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toEqual([
      {
        key: "2026-06-10",
        value: { ingestedAt: 1_000, lastDreamingDayIngested: "2026-06-10" },
      },
    ]);
  });

  it("reports ingestion state present from SQLite when legacy JSON is absent", async () => {
    const workspaceDir = await createWorkspace();
    // Write SQLite ingestion entries but NO legacy session-ingestion.json
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "main/session.jsonl",
          value: { lastSize: 120, lastMtimeMs: 1_000, lastContentHash: "hash", cursorLine: 42 },
        },
      ],
    });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionIngestionExists).toBe(true);
  });

  it("does not report session ingestion from the SQLite daily namespace", async () => {
    const workspaceDir = await createWorkspace();
    // Only daily ingestion namespace has rows
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "2026-06-10",
          value: { ingestedAt: Date.now() },
        },
      ],
    });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionIngestionExists).toBe(false);
  });

  it("targeted repair removes only heartbeat-derived corpus lines and clears scoped checkpoints", async () => {
    const workspaceDir = await createWorkspace();
    const sessionPath = path.join(
      workspaceDir,
      "..",
      "agents",
      "main",
      "sessions",
      "heartbeat-session.jsonl",
    );
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "[OpenClaw heartbeat poll]" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Heartbeat received. Main is active." }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "normal content" }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-11.txt",
    );
    await fs.writeFile(
      corpusPath,
      [
        "[main/sessions/heartbeat-session.jsonl#L2] Heartbeat received. Main is active.",
        "[main/sessions/heartbeat-session.jsonl#L3] normal content",
      ].join("\n"),
      "utf-8",
    );

    await Promise.all([
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main:sessions/heartbeat-session.jsonl",
            value: {
              lastSize: 120,
              lastMtimeMs: 1_000,
              lastContentHash: "hash",
              cursorLine: 42,
            },
          },
          {
            key: "main:sessions/other.jsonl",
            value: {
              lastSize: 200,
              lastMtimeMs: 2_000,
              lastContentHash: "hash-2",
              cursorLine: 10,
            },
          },
        ],
      }),
      writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "main:heartbeat-session:0",
            value: { scope: "main:heartbeat-session", index: 0, hashes: ["heartbeat"] },
          },
          {
            key: "main:other:0",
            value: { scope: "main:other", index: 0, hashes: ["other"] },
          },
        ],
      }),
    ]);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.changed).toBe(true);
    expect(repair.removedHeartbeatDerivedLines).toBe(1);
    expect((repair.clearedSessionCheckpointKeys ?? 0) > 0).toBe(true);
    const rewritten = await fs.readFile(corpusPath, "utf-8");
    expect(rewritten).toContain("normal content");
    expect(rewritten).not.toContain("Heartbeat received. Main is active.");

    const filesEntries = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(
      filesEntries.some((entry) => entry.key === "main:sessions/heartbeat-session.jsonl"),
    ).toBe(false);
    expect(filesEntries.some((entry) => entry.key === "main:sessions/other.jsonl")).toBe(true);

    const seenEntries = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
    });
    expect(seenEntries.some((entry) => entry.key === "main:heartbeat-session:0")).toBe(false);
    expect(seenEntries.some((entry) => entry.key === "main:other:0")).toBe(true);
  });

  it("detects heartbeat-derived corpus lines from SQLite-backed sessions", async () => {
    const workspaceDir = await createWorkspace();
    const sessionsDir = path.join(workspaceDir, "..", "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "heartbeat-sqlite";

    // Seed a SQLite-backed session with heartbeat user + assistant ack
    await appendSqliteTranscriptMessage(
      {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath,
      },
      {
        message: {
          role: "user",
          content: "[OpenClaw heartbeat poll]",
        },
      },
    );
    await appendSqliteTranscriptMessage(
      {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath,
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Heartbeat received. Main is active." }],
        },
      },
    );

    // Create a corpus ref WITHOUT .jsonl extension (SQLite logical path format)
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-11.txt",
    );
    await fs.writeFile(
      corpusPath,
      [
        `[main/sessions/${sessionId}#L3] Heartbeat received. Main is active.`,
        `[main/sessions/${sessionId}#L2] [OpenClaw heartbeat poll]`,
      ].join("\n"),
      "utf-8",
    );

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.heartbeatContaminatedSessionCorpusFileCount).toBe(1);
    expect(audit.heartbeatContaminatedSessionCorpusLineCount).toBe(1);
    expect(
      audit.issues.some((issue) => issue.code === "dreaming-session-corpus-heartbeat-derived"),
    ).toBe(true);

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.changed).toBe(true);
    expect(repair.removedHeartbeatDerivedLines).toBe(1);
    const rewritten = await fs.readFile(corpusPath, "utf-8");
    expect(rewritten).not.toContain("Heartbeat received. Main is active.");
  });

  it("does not remove fallback sentence by text without heartbeat provenance linkage", async () => {
    const workspaceDir = await createWorkspace();
    const sessionPath = path.join(workspaceDir, "..", "agents", "main", "sessions", "notes.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "A memory trace surfaced, but details were unavailable in this run.",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-11.txt",
    );
    await fs.writeFile(
      corpusPath,
      "[main/sessions/notes.jsonl#L1] A memory trace surfaced, but details were unavailable in this run.\n",
      "utf-8",
    );

    const repair = await repairDreamingArtifacts({ workspaceDir });

    expect(repair.removedHeartbeatDerivedLines).toBeUndefined();
    const rewritten = await fs.readFile(corpusPath, "utf-8");
    expect(rewritten).toContain(
      "A memory trace surfaced, but details were unavailable in this run.",
    );
  });
});
