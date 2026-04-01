/**
 * Audit logger tests.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditLogger } from "./audit-logger.file.js";
import { createNullAuditLogger } from "./audit-logger.null.js";
import { AUDIT_EVENT_TYPES } from "./audit.types.js";

describe("FileAuditLogger", () => {
  const testDir = join(tmpdir(), `audit-test-${randomUUID()}`);

  async function createTestLogger(config?: { maxBufferSize?: number; flushInterval?: number }) {
    await fs.mkdir(testDir, { recursive: true });
    return new FileAuditLogger({
      enabled: true,
      storageDir: testDir,
      maxBufferSize: config?.maxBufferSize ?? 1000,
      flushInterval: config?.flushInterval ?? 100,
    });
  }

  async function cleanup() {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }

  it("should log entries to buffer", async () => {
    const logger = await createTestLogger();

    await logger.log({
      actor: { userId: "test-user" },
      action: AUDIT_EVENT_TYPES.SESSION_INIT,
      sessionKey: "test-session",
      agentId: "test-agent",
      details: { mode: "oneshot" },
      result: "success",
    });

    const stats = await logger.getStats();
    expect(stats.totalEntries).toBe(1);
    expect(stats.entriesByAction[AUDIT_EVENT_TYPES.SESSION_INIT]).toBe(1);
    expect(stats.entriesByResult.success).toBe(1);

    await logger.close();
    await cleanup();
  });

  it("should flush buffer when full", async () => {
    const logger = await createTestLogger({ maxBufferSize: 5 });

    // Log 5 entries (fills buffer)
    for (let i = 0; i < 5; i++) {
      await logger.log({
        actor: { userId: `user-${i}` },
        action: AUDIT_EVENT_TYPES.SESSION_INIT,
        sessionKey: `session-${i}`,
        agentId: "agent",
        details: {},
        result: "success",
      });
    }

    // Give time for async flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check file was created
    const files = await fs.readdir(testDir);
    const logFiles = files.filter((f) => f.endsWith(".jsonl"));
    expect(logFiles.length).toBeGreaterThan(0);

    // Verify file contents
    const content = await fs.readFile(join(testDir, logFiles[0]), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(5);

    await logger.close();
    await cleanup();
  });

  it("should query logs by filters", async () => {
    const logger = await createTestLogger();

    // Log entries
    await logger.log({
      actor: { userId: "alice" },
      action: AUDIT_EVENT_TYPES.SESSION_INIT,
      sessionKey: "session-1",
      agentId: "agent-1",
      details: {},
      result: "success",
    });

    await logger.log({
      actor: { userId: "bob" },
      action: AUDIT_EVENT_TYPES.SESSION_INIT,
      sessionKey: "session-2",
      agentId: "agent-2",
      details: {},
      result: "success",
    });

    await logger.flush();

    // Query by userId
    const aliceLogs = await logger.query({ userId: "alice" });
    expect(aliceLogs).toHaveLength(1);
    expect(aliceLogs[0].actor.userId).toBe("alice");

    // Query by agentId
    const agentLogs = await logger.query({ agentId: "agent-1" });
    expect(agentLogs).toHaveLength(1);

    await logger.close();
    await cleanup();
  });

  it("should track failures", async () => {
    const logger = await createTestLogger();

    await logger.log({
      actor: { userId: "test-user" },
      action: AUDIT_EVENT_TYPES.TURN_FAILED,
      sessionKey: "test-session",
      agentId: "test-agent",
      details: {},
      result: "failure",
      error: {
        code: "TEST_ERROR",
        message: "Test error message",
      },
    });

    const stats = await logger.getStats();
    expect(stats.entriesByResult.failure).toBe(1);
    expect(stats.entriesByAction[AUDIT_EVENT_TYPES.TURN_FAILED]).toBe(1);

    await logger.close();
    await cleanup();
  });

  it("should prune old logs", async () => {
    const logger = await createTestLogger();

    // Create an old log file
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const oldDateStr = oldDate.toISOString().split("T")[0];
    const oldFile = join(testDir, `audit-${oldDateStr}.jsonl`);
    await fs.writeFile(oldFile, "test");

    // Prune logs older than 90 days
    const pruned = await logger.prune(Date.now() - 90 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);

    // Verify old file was deleted
    const exists = await fs
      .access(oldFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);

    await logger.close();
    await cleanup();
  });
});

describe("NullAuditLogger", () => {
  it("should be a no-op", async () => {
    const logger = createNullAuditLogger();

    await logger.log({
      actor: { userId: "test" },
      action: AUDIT_EVENT_TYPES.SESSION_INIT,
      sessionKey: "test",
      agentId: "agent",
      details: {},
      result: "success",
    });

    const stats = await logger.getStats();
    expect(stats.totalEntries).toBe(0);
    expect(stats.entriesByResult.success).toBe(0);

    const results = await logger.query({});
    expect(results).toHaveLength(0);

    await logger.flush();
    await logger.close();
  });
});

describe("AUDIT_EVENT_TYPES", () => {
  it("should have all required event types", () => {
    expect(AUDIT_EVENT_TYPES.SESSION_INIT).toBe("session_init");
    expect(AUDIT_EVENT_TYPES.SESSION_CLOSE).toBe("session_close");
    expect(AUDIT_EVENT_TYPES.SESSION_CANCEL).toBe("session_cancel");
    expect(AUDIT_EVENT_TYPES.RUNTIME_MODE_SET).toBe("runtime_mode_set");
    expect(AUDIT_EVENT_TYPES.RUNTIME_OPTIONS_SET).toBe("runtime_options_set");
    expect(AUDIT_EVENT_TYPES.TURN_START).toBe("turn_start");
    expect(AUDIT_EVENT_TYPES.TURN_COMPLETE).toBe("turn_complete");
    expect(AUDIT_EVENT_TYPES.TURN_FAILED).toBe("turn_failed");
    expect(AUDIT_EVENT_TYPES.ERROR).toBe("error");
  });
});
