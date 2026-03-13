import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

describe("prepareSessionManagerForRun", () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp("/tmp/session-init-test-");
    sessionFile = `${tmpDir}/test-session.jsonl`;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should update header id/cwd for new files without clearing", async () => {
    const sm = {
      sessionId: "old-id",
      flushed: false,
      fileEntries: [{ type: "session", id: "old-id", cwd: "/old" }],
    };

    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile,
      hadSessionFile: false,
      sessionId: "new-id",
      cwd: "/new",
    });

    expect(sm.fileEntries[0]).toEqual({ type: "session", id: "new-id", cwd: "/new" });
    expect(sm.sessionId).toBe("new-id");
  });

  it("should reset header-only files (pre-created session scenario)", async () => {
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ type: "session", id: "test-id", cwd: "/tmp" }) + "\n",
      "utf-8",
    );

    const sm = {
      sessionId: "test-id",
      flushed: true,
      fileEntries: [{ type: "session", id: "test-id", cwd: "/tmp" }],
      byId: new Map(),
      labelsById: new Map(),
      leafId: "some-leaf",
    };

    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile,
      hadSessionFile: true,
      sessionId: "test-id",
      cwd: "/tmp",
    });

    const content = await fs.readFile(sessionFile, "utf-8");
    expect(content).toBe("");
    expect(sm.fileEntries).toEqual([{ type: "session", id: "test-id", cwd: "/tmp" }]);
    expect(sm.flushed).toBe(false);
    expect(sm.byId.size).toBe(0);
    expect(sm.labelsById.size).toBe(0);
    expect(sm.leafId).toBe(null);

    // Verify archive was created
    const files = await fs.readdir(tmpDir);
    const archiveFile = files.find((f) => f.includes(".reset."));
    expect(archiveFile).toBeDefined();
  });

  it("should NOT reset when user message exists but no assistant (gateway restart mid-turn)", async () => {
    // This is the critical regression test for the bug fix.
    // Scenario: user sent a message, AI is processing, gateway restarts before assistant reply.
    const initialContent =
      JSON.stringify({ type: "session", id: "test-id", cwd: "/tmp" }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-001",
        parentId: null,
        timestamp: "2026-03-13T00:01:00.000Z",
        message: { role: "user", content: "还是不对，再试试" },
      }) +
      "\n";

    await fs.writeFile(sessionFile, initialContent, "utf-8");

    const sm = {
      sessionId: "test-id",
      flushed: true,
      fileEntries: [
        { type: "session", id: "test-id", cwd: "/tmp" },
        {
          type: "message",
          id: "msg-001",
          message: { role: "user", content: "还是不对，再试试" },
        },
      ],
      byId: new Map([["msg-001", {}]]),
      labelsById: new Map(),
      leafId: "msg-001",
    };

    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile,
      hadSessionFile: true,
      sessionId: "test-id",
      cwd: "/tmp",
    });

    // File should NOT be cleared
    const content = await fs.readFile(sessionFile, "utf-8");
    expect(content).toBe(initialContent);

    // Session manager state should be unchanged
    expect(sm.fileEntries.length).toBe(2);
    expect(sm.flushed).toBe(true);
    expect(sm.byId.size).toBe(1);
    expect(sm.leafId).toBe("msg-001");

    // No archive should be created
    const files = await fs.readdir(tmpDir);
    expect(files.filter((f) => f.includes(".reset."))).toHaveLength(0);
  });

  it("should NOT reset when both user and assistant messages exist", async () => {
    const initialContent =
      JSON.stringify({ type: "session", id: "test-id", cwd: "/tmp" }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-001",
        message: { role: "user", content: "Hello" },
      }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-002",
        message: { role: "assistant", content: "Hi there!" },
      }) +
      "\n";

    await fs.writeFile(sessionFile, initialContent, "utf-8");

    const sm = {
      sessionId: "test-id",
      flushed: true,
      fileEntries: [
        { type: "session", id: "test-id", cwd: "/tmp" },
        { type: "message", id: "msg-001", message: { role: "user", content: "Hello" } },
        { type: "message", id: "msg-002", message: { role: "assistant", content: "Hi there!" } },
      ],
      byId: new Map([
        ["msg-001", {}],
        ["msg-002", {}],
      ]),
      labelsById: new Map(),
      leafId: "msg-002",
    };

    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile,
      hadSessionFile: true,
      sessionId: "test-id",
      cwd: "/tmp",
    });

    // File should NOT be cleared
    const content = await fs.readFile(sessionFile, "utf-8");
    expect(content).toBe(initialContent);

    // Session manager state should be unchanged
    expect(sm.fileEntries.length).toBe(3);
    expect(sm.flushed).toBe(true);
    expect(sm.byId.size).toBe(2);
    expect(sm.leafId).toBe("msg-002");

    // No archive should be created
    const files = await fs.readdir(tmpDir);
    expect(files.filter((f) => f.includes(".reset."))).toHaveLength(0);
  });
});
