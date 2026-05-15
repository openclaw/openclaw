import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./pi-session-manager-memory-bound.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

let tmpDir: string | undefined;
let previousMaxEntriesEnv: string | undefined;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-manager-memory-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (previousMaxEntriesEnv === undefined) {
    delete process.env.PI_SESSION_MANAGER_MAX_IN_MEMORY_ENTRIES;
  } else {
    process.env.PI_SESSION_MANAGER_MAX_IN_MEMORY_ENTRIES = previousMaxEntriesEnv;
  }
  previousMaxEntriesEnv = undefined;

  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = undefined;
  }
});

function setMaxInMemoryEntriesForTest(value: string): void {
  previousMaxEntriesEnv = process.env.PI_SESSION_MANAGER_MAX_IN_MEMORY_ENTRIES;
  process.env.PI_SESSION_MANAGER_MAX_IN_MEMORY_ENTRIES = value;
}

function appendUser(manager: SessionManager, content: string): string {
  return manager.appendMessage({ role: "user", content } as AppendMessage);
}

function appendAssistant(manager: SessionManager, content: string): string {
  return manager.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
    }),
  );
}

describe("pi SessionManager memory retention", () => {
  it("drops stale pre-compaction entries from memory while preserving the persisted transcript", async () => {
    setMaxInMemoryEntriesForTest("256");
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    const staleEntryId = appendUser(manager, "stale user 0");
    appendAssistant(manager, "stale assistant 0");
    for (let index = 1; index < 150; index++) {
      appendUser(manager, `stale user ${index}`);
      appendAssistant(manager, `stale assistant ${index}`);
    }

    const thinkingEntryId = manager.appendThinkingLevelChange("high");
    const modelEntryId = manager.appendModelChange("anthropic", "claude-sonnet");
    const sessionInfoEntryId = manager.appendSessionInfo("Memory leak repro");
    const customEntryId = manager.appendCustomEntry("openclaw:test-state", { current: true });
    const firstKeptEntryId = appendUser(manager, "kept user");
    manager.appendLabelChange(firstKeptEntryId, "kept marker");
    appendAssistant(manager, "kept assistant");
    const compactionEntryId = manager.appendCompaction(
      "Summary of stale messages.",
      firstKeptEntryId,
      120_000,
    );

    for (let index = 0; index < 20; index++) {
      appendUser(manager, `post-compaction user ${index}`);
      appendAssistant(manager, `post-compaction assistant ${index}`);
    }

    const entries = manager.getEntries();
    const entryIds = new Set(entries.map((entry) => entry.id));
    expect(entries.length).toBeLessThan(80);
    expect(entryIds.has(staleEntryId)).toBe(false);
    expect(entryIds.has(thinkingEntryId)).toBe(true);
    expect(entryIds.has(modelEntryId)).toBe(true);
    expect(entryIds.has(sessionInfoEntryId)).toBe(true);
    expect(entryIds.has(customEntryId)).toBe(true);
    expect(entryIds.has(firstKeptEntryId)).toBe(true);
    expect(entryIds.has(compactionEntryId)).toBe(true);
    expect(manager.getLabel(firstKeptEntryId)).toBe("kept marker");
    expect(manager.getSessionName()).toBe("Memory leak repro");

    const sessionContext = manager.buildSessionContext();
    expect(sessionContext.thinkingLevel).toBe("high");
    const contextText = JSON.stringify(sessionContext.messages);
    expect(contextText).toContain("Summary of stale messages.");
    expect(contextText).toContain("kept user");
    expect(contextText).toContain("post-compaction assistant 19");
    expect(contextText).not.toContain("stale user 0");

    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    const persistedTranscript = await fs.readFile(sessionFile!, "utf8");
    expect(persistedTranscript).toContain("stale user 0");
    expect(persistedTranscript).toContain("post-compaction assistant 19");
  });
});
