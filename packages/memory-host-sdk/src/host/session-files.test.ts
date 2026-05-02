import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionEntry,
  extractSessionIdFromTranscriptFileName,
  isCronRunTranscriptPath,
  isDreamingNarrativeTranscriptPath,
  listSessionFilesForAgent,
  loadSessionTranscriptClassificationForSessionsDir,
  lookupSessionKeyForTranscriptPath,
  sessionPathForFile,
} from "./session-files.js";

let fixtureRoot: string;
let tmpDir: string;
let originalStateDir: string | undefined;
let fixtureId = 0;

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
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("listSessionFilesForAgent", () => {
  it("includes reset and deleted transcripts in session file listing", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    fsSync.mkdirSync(path.join(sessionsDir, "archive"), { recursive: true });

    const included = [
      "active.jsonl",
      "active.jsonl.reset.2026-02-16T22-26-33.000Z",
      "active.jsonl.deleted.2026-02-16T22-27-33.000Z",
    ];
    const excluded = ["active.jsonl.bak.2026-02-16T22-28-33.000Z", "sessions.json", "notes.md"];
    excluded.push("active.checkpoint.11111111-1111-4111-8111-111111111111.jsonl");

    for (const fileName of [...included, ...excluded]) {
      fsSync.writeFileSync(path.join(sessionsDir, fileName), "");
    }
    fsSync.writeFileSync(
      path.join(sessionsDir, "archive", "nested.jsonl.deleted.2026-02-16T22-29-33.000Z"),
      "",
    );

    const files = await listSessionFilesForAgent("main");

    expect(files.map((filePath) => path.basename(filePath)).toSorted()).toEqual(
      included.toSorted(),
    );
  });
});

describe("buildSessionEntry", () => {
  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real session JSONL file with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
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

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("skips deleted and checkpoint transcripts for dreaming ingestion", async () => {
    const deletedPath = path.join(tmpDir, "ordinary.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const checkpointPath = path.join(
      tmpDir,
      "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    const content = JSON.stringify({
      type: "message",
      message: { role: "user", content: "This should never reach the dreaming corpus." },
    });
    fsSync.writeFileSync(deletedPath, content);
    fsSync.writeFileSync(checkpointPath, content);

    const deletedEntry = await buildSessionEntry(deletedPath);
    const checkpointEntry = await buildSessionEntry(checkpointPath);

    expect(deletedEntry).not.toBeNull();
    expect(deletedEntry?.content).toBe("");
    expect(deletedEntry?.lineMap).toEqual([]);
    expect(checkpointEntry).not.toBeNull();
    expect(checkpointEntry?.content).toBe("");
    expect(checkpointEntry?.lineMap).toEqual([]);
  });

  it("skips blank lines and invalid JSON without breaking lineMap", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
    ];
    const filePath = path.join(tmpDir, "gaps.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
  });

  it("strips inbound metadata when a user envelope is split across text blocks", async () => {
    const jsonlLines = [
      JSON.stringify({
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
      }),
    ];
    const filePath = path.join(tmpDir, "enveloped-session-array.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("User: Actual user text");
  });

  it("skips inter-session user messages", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "A background task completed. Internal relay text.",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "User-facing summary." },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Actual user follow-up." },
      }),
    ];
    const filePath = path.join(tmpDir, "inter-session-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Assistant: User-facing summary.\nUser: Actual user follow-up.");
    expect(entry!.lineMap).toEqual([2, 3]);
  });

  it("drops internal-system runs until the next real user", async () => {
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Read HEARTBEAT.md. Reply HEARTBEAT_OK if nothing to do.",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "I'll read the heartbeat file." },
      }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "HEARTBEAT_OK" } }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Real user follow-up question." },
      }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Real reply." } }),
    ];
    const filePath = path.join(tmpDir, "internal-system-session.jsonl");
    fsSync.writeFileSync(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("User: Real user follow-up question.\nAssistant: Real reply.");
    expect(entry!.lineMap).toEqual([4, 5]);
  });
});

describe("transcript classification helpers", () => {
  function setupSessionsDir(opts: { cronSessionId: string; dreamingSessionId: string }): {
    sessionsDir: string;
    cronLivePath: string;
    dreamingLivePath: string;
  } {
    const sessionsDir = path.join(tmpDir, "sessions");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronLivePath = path.join(sessionsDir, `${opts.cronSessionId}.jsonl`);
    const dreamingLivePath = path.join(sessionsDir, `${opts.dreamingSessionId}.jsonl`);
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionId: opts.cronSessionId,
          sessionFile: cronLivePath,
        },
        "agent:main:dreaming-narrative-light-2026-04-25T06:00:00.000Z": {
          sessionId: opts.dreamingSessionId,
          sessionFile: dreamingLivePath,
        },
      }),
      "utf-8",
    );
    return { sessionsDir, cronLivePath, dreamingLivePath };
  }

  it("extracts session ids from live and rotated transcript file names", () => {
    expect(extractSessionIdFromTranscriptFileName("session-A.jsonl")).toBe("session-A");
    expect(
      extractSessionIdFromTranscriptFileName("session-A.jsonl.deleted.2026-04-25T06-33-10.801Z"),
    ).toBe("session-A");
    expect(
      extractSessionIdFromTranscriptFileName(
        "session-A.trajectory.jsonl.deleted.2026-04-25T06-33-10.801Z",
      ),
    ).toBe("session-A");
    expect(extractSessionIdFromTranscriptFileName("sessions.json")).toBeNull();
    expect(extractSessionIdFromTranscriptFileName("../bad.jsonl")).toBeNull();
  });

  it("classifies rotated cron and dreaming transcripts via session id", () => {
    const { sessionsDir } = setupSessionsDir({
      cronSessionId: "cron-rotated-id",
      dreamingSessionId: "dream-rotated-id",
    });
    const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(
      isCronRunTranscriptPath(
        classification,
        path.join(sessionsDir, "cron-rotated-id.jsonl.deleted.2026-04-25T06-33-10.801Z"),
      ),
    ).toBe(true);
    expect(
      isDreamingNarrativeTranscriptPath(
        classification,
        path.join(sessionsDir, "dream-rotated-id.jsonl.deleted.2026-04-25T06-33-10.801Z"),
      ),
    ).toBe(true);
  });

  it("looks up session keys for live and rotated transcript paths", () => {
    const { sessionsDir, cronLivePath } = setupSessionsDir({
      cronSessionId: "cron-key-id",
      dreamingSessionId: "dream-key-id",
    });
    const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);

    expect(lookupSessionKeyForTranscriptPath(classification, cronLivePath)).toBe(
      "agent:main:cron:job-1:run:run-1",
    );
    expect(
      lookupSessionKeyForTranscriptPath(
        classification,
        path.join(sessionsDir, "cron-key-id.jsonl.deleted.2026-04-25T06-33-10.801Z"),
      ),
    ).toBe("agent:main:cron:job-1:run:run-1");
  });

  it("normalizes source paths as documented sessions/basename values", () => {
    expect(sessionPathForFile(path.join(tmpDir, "abc.jsonl"))).toBe("sessions/abc.jsonl");
    expect(sessionPathForFile(path.join(tmpDir, "bad\nname.jsonl"))).toBe(
      "sessions/bad_name.jsonl",
    );
  });

  it("attributes cron mirror transcripts named after runId back to the cron sessionKey", () => {
    // Reproduces the leak scenario: cron runs sometimes leave a second
    // transcript whose basename equals the runId embedded in the sessionKey,
    // distinct from entry.sessionId. Without runId reverse lookup the mirror
    // file looks like an unowned orphan and slips into the dreaming corpus.
    const sessionsDir = path.join(tmpDir, "sessions-mirror");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const cronSessionId = "cron-primary-id";
    const cronRunId = "cron-mirror-run-id";
    const primaryPath = path.join(sessionsDir, `${cronSessionId}.jsonl`);
    const mirrorPath = path.join(sessionsDir, `${cronRunId}.jsonl`);
    const mirrorRotatedPath = path.join(
      sessionsDir,
      `${cronRunId}.jsonl.deleted.2026-04-25T06-33-10.801Z`,
    );
    fsSync.writeFileSync(primaryPath, "");
    fsSync.writeFileSync(mirrorPath, "");
    fsSync.writeFileSync(mirrorRotatedPath, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:cron:job-x:run:${cronRunId}`]: {
          sessionId: cronSessionId,
          sessionFile: primaryPath,
        },
      }),
      "utf-8",
    );

    const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
    const expectedKey = `agent:main:cron:job-x:run:${cronRunId}`;

    expect(lookupSessionKeyForTranscriptPath(classification, primaryPath)).toBe(expectedKey);
    expect(lookupSessionKeyForTranscriptPath(classification, mirrorPath)).toBe(expectedKey);
    expect(lookupSessionKeyForTranscriptPath(classification, mirrorRotatedPath)).toBe(expectedKey);
    expect(isCronRunTranscriptPath(classification, primaryPath)).toBe(true);
    expect(isCronRunTranscriptPath(classification, mirrorPath)).toBe(true);
    expect(isCronRunTranscriptPath(classification, mirrorRotatedPath)).toBe(true);
  });

  it("does not let runId reverse lookup overwrite a registered sessionId mapping", () => {
    // Defensive: if some other entry happens to register the same id as its
    // sessionId, that direct registration must win over the cron-runId fallback.
    const sessionsDir = path.join(tmpDir, "sessions-mirror-collision");
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    const collisionId = "shared-id";
    const explicitFile = path.join(sessionsDir, `${collisionId}.jsonl`);
    const cronPrimaryFile = path.join(sessionsDir, "cron-primary.jsonl");
    fsSync.writeFileSync(explicitFile, "");
    fsSync.writeFileSync(cronPrimaryFile, "");
    fsSync.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:explicit:${collisionId}`]: {
          sessionId: collisionId,
          sessionFile: explicitFile,
        },
        [`agent:main:cron:job-y:run:${collisionId}`]: {
          sessionId: "cron-primary",
          sessionFile: cronPrimaryFile,
        },
      }),
      "utf-8",
    );

    const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
    expect(lookupSessionKeyForTranscriptPath(classification, explicitFile)).toBe(
      `agent:main:explicit:${collisionId}`,
    );
  });
});
