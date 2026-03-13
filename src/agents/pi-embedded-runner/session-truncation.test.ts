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

    // Run again — no message entries left to remove
    const second = await truncateSessionAfterCompaction({ sessionFile });
    expect(second.truncated).toBe(false);
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

    // Should preserve both compactions (older compactions are non-message state)
    // but remove the summarized message entries
    const smAfter = SessionManager.open(sessionFile);
    const branchAfter = smAfter.getBranch();
    expect(branchAfter[0].type).toBe("compaction");

    // Both compaction entries are preserved (non-message state is kept)
    const compactionEntries = branchAfter.filter((e) => e.type === "compaction");
    expect(compactionEntries).toHaveLength(2);

    // But message entries before the latest compaction were removed
    const entriesAfter = smAfter.getEntries().length;
    expect(entriesAfter).toBeLessThan(entriesBefore);

    // No message entries should exist before the latest compaction
    const latestCompIdx = branchAfter.findIndex(
      (e) => e.type === "compaction" && e === compactionEntries[compactionEntries.length - 1],
    );
    const messagesBeforeLatest = branchAfter
      .slice(0, latestCompIdx)
      .filter((e) => e.type === "message");
    expect(messagesBeforeLatest).toHaveLength(0);
  });

  it("preserves non-message session state during truncation", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);

    // Messages before compaction
    sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sm.appendMessage(makeAssistant("hi", 2));

    // Non-message state entries interleaved with messages
    sm.appendModelChange("anthropic", "claude-sonnet-4-5-20250514");
    sm.appendThinkingLevelChange("high");
    sm.appendCustomEntry("my-extension", { key: "value" });
    sm.appendSessionInfo("my session");

    sm.appendMessage({ role: "user", content: "do task", timestamp: 3 });
    sm.appendMessage(makeAssistant("done", 4));

    // Compaction summarizing the conversation
    const branch = sm.getBranch();
    const firstKeptId = branch[branch.length - 1].id;
    sm.appendCompaction("Summary.", firstKeptId, 5000);

    // Post-compaction messages
    sm.appendMessage({ role: "user", content: "next", timestamp: 5 });

    const sessionFile = sm.getSessionFile()!;
    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(true);

    // Verify non-message entries are preserved
    const smAfter = SessionManager.open(sessionFile);
    const allAfter = smAfter.getEntries();
    const types = allAfter.map((e) => e.type);

    expect(types).toContain("model_change");
    expect(types).toContain("thinking_level_change");
    expect(types).toContain("custom");
    expect(types).toContain("session_info");
    expect(types).toContain("compaction");

    // Message entries before compaction should be gone
    const branchAfter = smAfter.getBranch();
    const compIdx = branchAfter.findIndex((e) => e.type === "compaction");
    const msgsBefore = branchAfter.slice(0, compIdx).filter((e) => e.type === "message");
    expect(msgsBefore).toHaveLength(0);

    // Session context should still work
    const ctx = smAfter.buildSessionContext();
    expect(ctx.messages.length).toBeGreaterThan(0);
    // Model and thinking state should be recoverable
    expect(ctx.model?.modelId).toBe("claude-sonnet-4-5-20250514");
    expect(ctx.thinkingLevel).toBe("high");
  });

  it("preserves unsummarized sibling branches during truncation", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);

    // Build main conversation
    sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sm.appendMessage(makeAssistant("hi there", 2));

    // Save a branch point
    const branchPoint = sm.getBranch();
    const branchFromId = branchPoint[branchPoint.length - 1].id;

    // Continue main branch
    sm.appendMessage({ role: "user", content: "do task A", timestamp: 3 });
    sm.appendMessage(makeAssistant("done A", 4));

    // Create a sibling branch from the earlier point
    sm.branch(branchFromId);
    sm.appendMessage({ role: "user", content: "do task B instead", timestamp: 5 });
    const siblingMsg = sm.appendMessage(makeAssistant("done B", 6));

    // Go back to main branch tip and add compaction there
    sm.branch(branchFromId);
    sm.appendMessage({ role: "user", content: "do task A", timestamp: 3 });
    sm.appendMessage(makeAssistant("done A take 2", 7));
    const mainBranch = sm.getBranch();
    const firstKeptId = mainBranch[mainBranch.length - 1].id;
    sm.appendCompaction("Summary of main branch.", firstKeptId, 5000);
    sm.appendMessage({ role: "user", content: "next", timestamp: 8 });

    const sessionFile = sm.getSessionFile()!;

    const entriesBefore = sm.getEntries();

    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(true);

    // Verify sibling branch is preserved in the full entry list
    const smAfter = SessionManager.open(sessionFile);
    const allAfter = smAfter.getEntries();

    // The sibling branch message should still exist
    const siblingAfter = allAfter.find((e) => e.id === siblingMsg);
    expect(siblingAfter).toBeDefined();

    // The tree should have entries from both branches
    const tree = smAfter.getTree();
    expect(tree.length).toBeGreaterThan(0);

    // Total entries should be less (main branch messages removed) but not zero
    expect(allAfter.length).toBeGreaterThan(0);
    expect(allAfter.length).toBeLessThan(entriesBefore.length);
  });
});
