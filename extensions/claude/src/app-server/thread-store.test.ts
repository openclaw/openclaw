import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readClaudeAppServerBinding,
  recordClaudeThreadTurnSummary,
  writeClaudeAppServerBinding,
} from "./thread-store.js";

describe("recordClaudeThreadTurnSummary", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-thread-store-test-"));
    sessionFile = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is a no-op when no binding exists yet", async () => {
    await recordClaudeThreadTurnSummary(sessionFile, { stopReason: "stop" });
    const binding = await readClaudeAppServerBinding(sessionFile);
    expect(binding).toBeNull();
  });

  it("attaches stop reason, usage, and a preview to an existing binding", async () => {
    await writeClaudeAppServerBinding(sessionFile, {
      threadId: "thr_1",
      cwd: dir,
      model: "claude-sonnet-5",
    });
    await recordClaudeThreadTurnSummary(sessionFile, {
      stopReason: "stop",
      usage: { input: 100, output: 20, total: 120 },
      assistantPreview: "Hello there!",
    });
    const binding = await readClaudeAppServerBinding(sessionFile);
    expect(binding?.lastTurnStopReason).toBe("stop");
    expect(binding?.lastTurnUsage).toEqual({ input: 100, output: 20, total: 120 });
    expect(binding?.lastAssistantPreview).toBe("Hello there!");
    expect(binding?.turnCount).toBe(1);
    // Preserves fields it didn't touch.
    expect(binding?.threadId).toBe("thr_1");
    expect(binding?.model).toBe("claude-sonnet-5");
  });

  it("increments turnCount across successive turns", async () => {
    await writeClaudeAppServerBinding(sessionFile, { threadId: "thr_1", cwd: dir });
    await recordClaudeThreadTurnSummary(sessionFile, { stopReason: "stop" });
    await recordClaudeThreadTurnSummary(sessionFile, { stopReason: "stop" });
    const binding = await readClaudeAppServerBinding(sessionFile);
    expect(binding?.turnCount).toBe(2);
  });

  it("truncates a long preview and appends an ellipsis", async () => {
    await writeClaudeAppServerBinding(sessionFile, { threadId: "thr_1", cwd: dir });
    const longText = "x".repeat(500);
    await recordClaudeThreadTurnSummary(sessionFile, { assistantPreview: longText });
    const binding = await readClaudeAppServerBinding(sessionFile);
    expect(binding?.lastAssistantPreview?.length).toBe(201);
    expect(binding?.lastAssistantPreview?.endsWith("…")).toBe(true);
  });

  it("always stamps a fresh updatedAt, even though it read-modify-writes onto an object that already carries the old one", async () => {
    await writeClaudeAppServerBinding(sessionFile, { threadId: "thr_1", cwd: dir });
    const first = await readClaudeAppServerBinding(sessionFile);
    const firstUpdatedAt = first?.updatedAt;
    expect(firstUpdatedAt).toBeDefined();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await recordClaudeThreadTurnSummary(sessionFile, { stopReason: "stop" });
    const second = await readClaudeAppServerBinding(sessionFile);
    // Before the fix: spreading `...existing` (which carries the OLD
    // updatedAt) onto the object AFTER the freshly computed `now` clobbered
    // it back to the stale value, so this would equal firstUpdatedAt.
    expect(second?.updatedAt).toBeGreaterThan(firstUpdatedAt ?? 0);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("keeps the previous preview when the new turn's summary omits one", async () => {
    await writeClaudeAppServerBinding(sessionFile, { threadId: "thr_1", cwd: dir });
    await recordClaudeThreadTurnSummary(sessionFile, { assistantPreview: "first reply" });
    await recordClaudeThreadTurnSummary(sessionFile, { stopReason: "toolUse" });
    const binding = await readClaudeAppServerBinding(sessionFile);
    expect(binding?.lastAssistantPreview).toBe("first reply");
    expect(binding?.lastTurnStopReason).toBe("toolUse");
  });
});
