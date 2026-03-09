import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { truncateSessionAfterCompaction } from "./session-truncation.js";

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-truncation-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    timestamp,
  });
}

function createSessionWithCompaction(sessionDir: string): string {
  const sm = SessionManager.create(sessionDir, sessionDir);
  // Add messages before compaction
  sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  sm.appendMessage(makeAssistant("hi there", 2));
  sm.appendMessage({ role: "user", content: "do something", timestamp: 3 });
  sm.appendMessage(makeAssistant("done", 4));

  // Add compaction (summarizing the above)
  const branch = sm.getBranch();
  const firstKeptId = branch[branch.length - 1].id;
  sm.appendCompaction("Summary of conversation so far.", firstKeptId, 5000);

  // Add messages after compaction
  sm.appendMessage({ role: "user", content: "next task", timestamp: 5 });
  sm.appendMessage(makeAssistant("working on it", 6));

  return sm.getSessionFile()!;
}

describe("truncateSessionAfterCompaction", () => {
  it("removes entries before compaction and keeps entries after (#39953)", async () => {
    const dir = await createTmpDir();
    const sessionFile = createSessionWithCompaction(dir);

    // Verify pre-truncation state
    const smBefore = SessionManager.open(sessionFile);
    const entriesBefore = smBefore.getEntries().length;
    expect(entriesBefore).toBeGreaterThan(5); // 4 messages + compaction + 2 messages

    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(true);
    expect(result.entriesRemoved).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore!);

    // Verify post-truncation: file is still a valid session
    const smAfter = SessionManager.open(sessionFile);
    const entriesAfter = smAfter.getEntries().length;
    expect(entriesAfter).toBeLessThan(entriesBefore);

    // The branch should contain compaction + post-compaction messages
    const branchAfter = smAfter.getBranch();
    expect(branchAfter[0].type).toBe("compaction");
    expect(branchAfter[0].parentId).toBeNull();

    // Session context should still work
    const ctx = smAfter.buildSessionContext();
    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it("skips truncation when no compaction entry exists", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    // appendMessage implicitly creates the session file
    sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sm.appendMessage(makeAssistant("hi", 2));
    sm.appendMessage({ role: "user", content: "bye", timestamp: 3 });
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(false);
    expect(result.reason).toBe("no compaction entry found");
  });

  it("is idempotent — second truncation is a no-op", async () => {
    const dir = await createTmpDir();
    const sessionFile = createSessionWithCompaction(dir);

    const first = await truncateSessionAfterCompaction({ sessionFile });
    expect(first.truncated).toBe(true);

    // Run again — compaction is now at root, nothing more to remove
    const second = await truncateSessionAfterCompaction({ sessionFile });
    expect(second.truncated).toBe(false);
    expect(second.reason).toBe("compaction already at root");
  });

  it("archives original file when archivePath is provided (#39953)", async () => {
    const dir = await createTmpDir();
    const sessionFile = createSessionWithCompaction(dir);
    const archivePath = path.join(dir, "archive", "backup.jsonl");

    const result = await truncateSessionAfterCompaction({ sessionFile, archivePath });

    expect(result.truncated).toBe(true);
    const archiveExists = await fs
      .stat(archivePath)
      .then(() => true)
      .catch(() => false);
    expect(archiveExists).toBe(true);

    // Archive should be larger than truncated file (it has the full history)
    const archiveSize = (await fs.stat(archivePath)).size;
    const truncatedSize = (await fs.stat(sessionFile)).size;
    expect(archiveSize).toBeGreaterThan(truncatedSize);
  });

  it("handles multiple compaction cycles (#39953)", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);

    // First cycle: messages + compaction
    sm.appendMessage({ role: "user", content: "cycle 1 message 1", timestamp: 1 });
    sm.appendMessage(makeAssistant("response 1", 2));
    const branch1 = sm.getBranch();
    sm.appendCompaction("Summary of cycle 1.", branch1[branch1.length - 1].id, 3000);

    // Second cycle: more messages + another compaction
    sm.appendMessage({ role: "user", content: "cycle 2 message 1", timestamp: 3 });
    sm.appendMessage(makeAssistant("response 2", 4));
    const branch2 = sm.getBranch();
    sm.appendCompaction("Summary of cycles 1 and 2.", branch2[branch2.length - 1].id, 6000);

    // Post-compaction messages
    sm.appendMessage({ role: "user", content: "final question", timestamp: 5 });

    const sessionFile = sm.getSessionFile()!;
    const entriesBefore = sm.getEntries().length;

    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(true);

    // Should keep only the latest compaction + entries after it
    const smAfter = SessionManager.open(sessionFile);
    const branchAfter = smAfter.getBranch();
    expect(branchAfter[0].type).toBe("compaction");

    // Only the latest compaction should remain
    const compactionEntries = branchAfter.filter((e) => e.type === "compaction");
    expect(compactionEntries).toHaveLength(1);

    const entriesAfter = smAfter.getEntries().length;
    expect(entriesAfter).toBeLessThan(entriesBefore);
  });
});
