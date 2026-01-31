/**
 * Tests for Cursor Agent webhook monitor.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processWebhookEvent } from "./monitor.js";
import { clearTasks, setTask, getTask } from "./task-store.js";
import type { CursorAgentWebhookPayload } from "./types.js";

// Helper to create a valid signature
function createSignature(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

describe("processWebhookEvent", () => {
  const secret = "test-webhook-secret";

  it("should process valid webhook payload", async () => {
    const payload: CursorAgentWebhookPayload = {
      event: "statusChange",
      timestamp: "2024-01-15T10:30:00Z",
      id: "bc_test123",
      status: "FINISHED",
      source: {
        repository: "https://github.com/test/repo",
        ref: "main",
      },
      target: {
        url: "https://cursor.com/agents?id=bc_test123",
        branchName: "cursor/fix-bug-123",
        prUrl: "https://github.com/test/repo/pull/42",
      },
      summary: "Fixed the bug",
    };

    const payloadString = JSON.stringify(payload);
    const signature = createSignature(payloadString, secret);

    const result = await processWebhookEvent(payloadString, signature, secret);

    expect(result).not.toBeNull();
    expect(result?.id).toBe("bc_test123");
    expect(result?.status).toBe("FINISHED");
    expect(result?.summary).toBe("Fixed the bug");
  });

  it("should reject invalid signature", async () => {
    const payload = JSON.stringify({ event: "statusChange", id: "bc_test" });

    await expect(processWebhookEvent(payload, "sha256=invalid", secret)).rejects.toThrow(
      "Invalid webhook signature",
    );
  });

  it("should process payload without signature when no secret", async () => {
    const payload: CursorAgentWebhookPayload = {
      event: "statusChange",
      timestamp: "2024-01-15T10:30:00Z",
      id: "bc_nosig",
      status: "RUNNING",
      source: {
        repository: "https://github.com/test/repo",
        ref: "main",
      },
    };

    const result = await processWebhookEvent(JSON.stringify(payload), null, "");

    expect(result?.id).toBe("bc_nosig");
    expect(result?.status).toBe("RUNNING");
  });
});

describe("webhook payload formats", () => {
  it("should handle FINISHED status with PR", () => {
    const payload: CursorAgentWebhookPayload = {
      event: "statusChange",
      timestamp: new Date().toISOString(),
      id: "bc_finished",
      status: "FINISHED",
      source: {
        repository: "https://github.com/user/repo",
        ref: "main",
      },
      target: {
        branchName: "cursor/feature-123",
        prUrl: "https://github.com/user/repo/pull/99",
      },
      summary: "Added new feature",
    };

    expect(payload.status).toBe("FINISHED");
    expect(payload.target?.prUrl).toContain("pull/99");
  });

  it("should handle ERROR status", () => {
    const payload: CursorAgentWebhookPayload = {
      event: "statusChange",
      timestamp: new Date().toISOString(),
      id: "bc_error",
      status: "ERROR",
      source: {
        repository: "https://github.com/user/repo",
        ref: "main",
      },
      error: "Repository not found",
    };

    expect(payload.status).toBe("ERROR");
    expect(payload.error).toBe("Repository not found");
  });

  it("should handle RUNNING status", () => {
    const payload: CursorAgentWebhookPayload = {
      event: "statusChange",
      timestamp: new Date().toISOString(),
      id: "bc_running",
      status: "RUNNING",
      source: {
        repository: "https://github.com/user/repo",
        ref: "feature-branch",
      },
    };

    expect(payload.status).toBe("RUNNING");
    expect(payload.source.ref).toBe("feature-branch");
  });
});

describe("task correlation", () => {
  beforeEach(() => {
    clearTasks();
  });

  afterEach(() => {
    clearTasks();
  });

  it("should find task by ID", () => {
    setTask({
      id: "bc_corr123",
      sessionKey: "session_abc",
      accountId: "default",
      instructions: "Fix bug",
      repository: "https://github.com/test/repo",
      branch: "main",
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const task = getTask("bc_corr123");
    expect(task).not.toBeUndefined();
    expect(task?.sessionKey).toBe("session_abc");
  });

  it("should return undefined for unknown task", () => {
    const task = getTask("bc_unknown");
    expect(task).toBeUndefined();
  });
});
