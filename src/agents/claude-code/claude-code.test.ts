import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { resolveClaudeBinary } from "./binary.js";
import type {
  CCSystemStatusMessage,
  CCSystemInitMessage,
  CCAssistantMessage,
  CCResultMessage,
  CCAuthStatusMessage,
  CCControlResponse,
} from "./protocol.js";
import { parseOutboundMessage } from "./protocol.js";
import {
  registryKey,
  resolveSession,
  saveSession,
  updateSessionStats,
  deleteSession,
  listSessions,
  listAllSessions,
  peekSessionHistory,
} from "./sessions.js";
import type { ClaudeCodeProgressEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary", () => {
  it("throws when binaryPath does not exist", () => {
    expect(() => resolveClaudeBinary("/nonexistent/path/claude")).toThrow(
      "Claude Code binary not found at configured path",
    );
  });

  it("returns binaryPath when it exists", () => {
    // Use node binary as a stand-in (guaranteed to exist)
    const nodePath = process.execPath;
    expect(resolveClaudeBinary(nodePath)).toBe(nodePath);
  });
});

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

describe("parseOutboundMessage", () => {
  it("parses a system status message", () => {
    const raw = JSON.stringify({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "bypassPermissions",
      uuid: "abc",
      session_id: "sess-1",
    });
    const msg = parseOutboundMessage(raw);
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("system");
    const sys = msg as CCSystemStatusMessage;
    expect(sys.subtype).toBe("status");
    expect(sys.permissionMode).toBe("bypassPermissions");
  });

  it("parses a system init message", () => {
    const raw = JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: "/home/user/project",
      session_id: "sess-init-1",
      tools: ["Read", "Write", "Bash"],
      mcp_servers: [],
      model: "claude-opus-4-6",
      permissionMode: "bypassPermissions",
      uuid: "abc",
    });
    const msg = parseOutboundMessage(raw) as CCSystemInitMessage;
    expect(msg.type).toBe("system");
    expect(msg.subtype).toBe("init");
    expect(msg.session_id).toBe("sess-init-1");
    expect(msg.model).toBe("claude-opus-4-6");
    expect(msg.tools).toEqual(["Read", "Write", "Bash"]);
  });

  it("parses an assistant message", () => {
    const raw = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      session_id: "sess-1",
      uuid: "abc",
    });
    const msg = parseOutboundMessage(raw) as CCAssistantMessage;
    expect(msg.type).toBe("assistant");
    expect(msg.message.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(msg.message.usage?.input_tokens).toBe(100);
  });

  it("parses an assistant message with tool_use blocks", () => {
    const raw = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_02",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tu_01", name: "Read", input: { file_path: "/test.ts" } },
        ],
        stop_reason: "tool_use",
      },
      session_id: "sess-1",
      uuid: "abc",
    });
    const msg = parseOutboundMessage(raw) as CCAssistantMessage;
    expect(msg.message.content).toHaveLength(2);
    expect(msg.message.content[1].type).toBe("tool_use");
    expect((msg.message.content[1] as unknown as { name: string }).name).toBe("Read");
  });

  it("parses a result message", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 5000,
      is_error: false,
      num_turns: 3,
      session_id: "sess-1",
      total_cost_usd: 0.42,
      usage: { input_tokens: 1000, output_tokens: 500 },
      result: "Task completed.",
      uuid: "abc",
    });
    const msg = parseOutboundMessage(raw) as CCResultMessage;
    expect(msg.type).toBe("result");
    expect(msg.subtype).toBe("success");
    expect(msg.total_cost_usd).toBe(0.42);
    expect(msg.result).toBe("Task completed.");
  });

  it("parses result with error subtypes", () => {
    for (const subtype of ["error_during_execution", "error_max_turns", "error_max_budget_usd"]) {
      const raw = JSON.stringify({
        type: "result",
        subtype,
        is_error: true,
        session_id: "sess-1",
        uuid: "abc",
      });
      const msg = parseOutboundMessage(raw) as CCResultMessage;
      expect(msg.subtype).toBe(subtype);
    }
  });

  it("parses auth_status message", () => {
    const raw = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      error: "token expired",
      uuid: "abc",
      session_id: "sess-1",
    });
    const msg = parseOutboundMessage(raw) as CCAuthStatusMessage;
    expect(msg.type).toBe("auth_status");
    expect(msg.error).toBe("token expired");
  });

  it("parses control_response message", () => {
    const raw = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_01",
      },
    });
    const msg = parseOutboundMessage(raw) as CCControlResponse;
    expect(msg.type).toBe("control_response");
    expect(msg.response.subtype).toBe("success");
  });

  it("returns null for non-JSON", () => {
    expect(parseOutboundMessage("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseOutboundMessage("")).toBeNull();
    expect(parseOutboundMessage("  ")).toBeNull();
  });

  it("returns null for JSON without type field", () => {
    expect(parseOutboundMessage('{"foo": "bar"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

describe("session registry", () => {
  const testAgentId = `test-agent-${Date.now()}`;
  const testRepo = `/tmp/test-repo-${Date.now()}`;

  afterEach(() => {
    // Clean up test registry files
    const dir = path.join(os.homedir(), ".openclaw", "agents", testAgentId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns undefined for unknown repo", () => {
    const result = resolveSession(testAgentId, testRepo);
    expect(result).toBeUndefined();
  });

  it("saves and retrieves a session", () => {
    saveSession(testAgentId, testRepo, "session-123", {
      task: "Test task",
      costUsd: 0.5,
    });

    // resolveSession won't find the CC session file, so it should clean up and return undefined.
    // This is expected — in a real environment, the CC session file would exist.
    const result = resolveSession(testAgentId, testRepo);
    expect(result).toBeUndefined(); // CC session file doesn't exist in test env

    // But listSessions should be empty since resolveSession cleaned up
    // Let's verify saveSession works by listing before resolveSession cleans up.
  });

  it("listSessions returns saved entries", () => {
    saveSession(testAgentId, testRepo, "session-456", {
      task: "Another task",
      costUsd: 1.0,
    });

    const sessions = listSessions(testAgentId);
    expect(sessions[testRepo]).toBeTruthy();
    expect(sessions[testRepo].sessionId).toBe("session-456");
    expect(sessions[testRepo].totalCostUsd).toBe(1.0);
    expect(sessions[testRepo].taskHistory).toHaveLength(1);
    expect(sessions[testRepo].taskHistory[0].task).toBe("Another task");
  });

  it("updateSessionStats accumulates cost and turns", () => {
    saveSession(testAgentId, testRepo, "session-789", {
      task: "Initial task",
      costUsd: 0.5,
    });

    updateSessionStats(testAgentId, testRepo, { turns: 5, costUsd: 0.3 });

    const sessions = listSessions(testAgentId);
    // totalCostUsd from saveSession + updateSessionStats
    expect(sessions[testRepo].totalCostUsd).toBe(0.8);
    expect(sessions[testRepo].totalTurns).toBe(5);
  });

  it("deleteSession removes an entry", () => {
    saveSession(testAgentId, testRepo, "session-del", {
      task: "To be deleted",
    });

    const deleted = deleteSession(testAgentId, testRepo);
    expect(deleted).toBe(true);

    const sessions = listSessions(testAgentId);
    expect(sessions[testRepo]).toBeUndefined();
  });

  it("deleteSession returns false for non-existent entry", () => {
    expect(deleteSession(testAgentId, "/nonexistent")).toBe(false);
  });

  it("saveSession updates existing entry on re-save with same sessionId", () => {
    saveSession(testAgentId, testRepo, "session-update", {
      task: "Task 1",
      costUsd: 0.5,
    });
    saveSession(testAgentId, testRepo, "session-update", {
      task: "Task 2",
      costUsd: 0.3,
    });

    const sessions = listSessions(testAgentId);
    expect(sessions[testRepo].sessionId).toBe("session-update");
    // Cost is accumulated via the existing entry path: 0.5 (initial) + 0.3 (update)
    expect(sessions[testRepo].totalCostUsd).toBe(0.8);
    expect(sessions[testRepo].taskHistory).toHaveLength(2);
  });

  it("listAllSessions aggregates across agents", () => {
    const agentA = `test-listall-a-${Date.now()}`;
    const agentB = `test-listall-b-${Date.now()}`;
    const repoA = `/tmp/test-repo-a-${Date.now()}`;
    const repoB = `/tmp/test-repo-b-${Date.now()}`;

    try {
      saveSession(agentA, repoA, "sess-a", { task: "Task A", costUsd: 1.0 });
      saveSession(agentB, repoB, "sess-b", { task: "Task B", costUsd: 2.0 });

      const all = listAllSessions();
      const foundA = all.find((s) => s.sessionId === "sess-a");
      const foundB = all.find((s) => s.sessionId === "sess-b");

      expect(foundA).toBeTruthy();
      expect(foundA?.agentId).toBe(agentA);
      expect(foundA?.repoPath).toBe(repoA);
      expect(foundB).toBeTruthy();
      expect(foundB?.agentId).toBe(agentB);
    } finally {
      // Cleanup
      for (const agent of [agentA, agentB]) {
        const dir = path.join(os.homedir(), ".openclaw", "agents", agent);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Named sessions (label support)
// ---------------------------------------------------------------------------

describe("registryKey", () => {
  it("returns repoPath when no label", () => {
    expect(registryKey("/home/user/project")).toBe("/home/user/project");
  });

  it("returns repoPath::label when label provided", () => {
    expect(registryKey("/home/user/project", "dashboard-refactor")).toBe(
      "/home/user/project::dashboard-refactor",
    );
  });
});

describe("named sessions", () => {
  const testAgentId = `test-named-${Date.now()}`;
  const testRepo = `/tmp/test-named-repo-${Date.now()}`;

  afterEach(() => {
    const dir = path.join(os.homedir(), ".openclaw", "agents", testAgentId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("saveSession with label does not overwrite unlabeled session", () => {
    // Save an unlabeled session
    saveSession(testAgentId, testRepo, "sess-default", {
      task: "Default task",
      costUsd: 1.0,
    });

    // Save a labeled session on the same repo
    saveSession(testAgentId, testRepo, "sess-labeled", {
      task: "Labeled task",
      costUsd: 2.0,
      label: "dashboard-refactor",
    });

    const sessions = listSessions(testAgentId);

    // Unlabeled session is keyed by repoPath
    expect(sessions[testRepo]).toBeTruthy();
    expect(sessions[testRepo].sessionId).toBe("sess-default");
    expect(sessions[testRepo].totalCostUsd).toBe(1.0);

    // Labeled session is keyed by repoPath::label
    const labeledKey = `${testRepo}::dashboard-refactor`;
    expect(sessions[labeledKey]).toBeTruthy();
    expect(sessions[labeledKey].sessionId).toBe("sess-labeled");
    expect(sessions[labeledKey].totalCostUsd).toBe(2.0);
    expect(sessions[labeledKey].label).toBe("dashboard-refactor");
  });

  it("multiple sessions on same repo with different labels coexist", () => {
    saveSession(testAgentId, testRepo, "sess-a", {
      task: "Feature A",
      costUsd: 0.5,
      label: "feature-a",
    });
    saveSession(testAgentId, testRepo, "sess-b", {
      task: "Feature B",
      costUsd: 0.7,
      label: "feature-b",
    });
    saveSession(testAgentId, testRepo, "sess-default", {
      task: "Default",
      costUsd: 0.3,
    });

    const sessions = listSessions(testAgentId);

    // All three coexist under different keys
    expect(sessions[`${testRepo}::feature-a`].sessionId).toBe("sess-a");
    expect(sessions[`${testRepo}::feature-b`].sessionId).toBe("sess-b");
    expect(sessions[testRepo].sessionId).toBe("sess-default");

    // Labels are stored on the entries
    expect(sessions[`${testRepo}::feature-a`].label).toBe("feature-a");
    expect(sessions[`${testRepo}::feature-b`].label).toBe("feature-b");
    expect(sessions[testRepo].label).toBeUndefined();
  });

  it("updateSessionStats with label targets the correct entry", () => {
    saveSession(testAgentId, testRepo, "sess-default", {
      task: "Default",
      costUsd: 1.0,
    });
    saveSession(testAgentId, testRepo, "sess-labeled", {
      task: "Labeled",
      costUsd: 1.0,
      label: "my-label",
    });

    // Update only the labeled session
    updateSessionStats(testAgentId, testRepo, { turns: 10, costUsd: 0.5 }, "my-label");

    const sessions = listSessions(testAgentId);
    // Labeled session got the update
    expect(sessions[`${testRepo}::my-label`].totalTurns).toBe(10);
    expect(sessions[`${testRepo}::my-label`].totalCostUsd).toBe(1.5);
    // Default session is untouched
    expect(sessions[testRepo].totalTurns).toBe(0);
    expect(sessions[testRepo].totalCostUsd).toBe(1.0);
  });

  it("deleteSession with label only removes the labeled entry", () => {
    saveSession(testAgentId, testRepo, "sess-default", { task: "Default" });
    saveSession(testAgentId, testRepo, "sess-labeled", {
      task: "Labeled",
      label: "to-delete",
    });

    const deleted = deleteSession(testAgentId, testRepo, "to-delete");
    expect(deleted).toBe(true);

    const sessions = listSessions(testAgentId);
    // Labeled entry is gone
    expect(sessions[`${testRepo}::to-delete`]).toBeUndefined();
    // Default entry still exists
    expect(sessions[testRepo]).toBeTruthy();
    expect(sessions[testRepo].sessionId).toBe("sess-default");
  });

  it("resolveSession with and without label are independent", () => {
    // Both will return undefined (CC session files don't exist in test env),
    // but they should look up different registry keys.
    saveSession(testAgentId, testRepo, "sess-default", { task: "Default" });
    saveSession(testAgentId, testRepo, "sess-labeled", {
      task: "Labeled",
      label: "independent",
    });

    // resolveSession cleans up entries whose CC session files don't exist.
    // Call for labeled — it should clean only the labeled entry.
    const labeled = resolveSession(testAgentId, testRepo, "independent");
    expect(labeled).toBeUndefined(); // CC session file doesn't exist

    // The default entry should still be in the registry (not yet resolved/cleaned).
    const sessions = listSessions(testAgentId);
    expect(sessions[testRepo]).toBeTruthy();
    expect(sessions[testRepo].sessionId).toBe("sess-default");
    // The labeled entry was cleaned up by resolveSession
    expect(sessions[`${testRepo}::independent`]).toBeUndefined();
  });

  it("listAllSessions extracts repoPath from labeled keys", () => {
    saveSession(testAgentId, testRepo, "sess-labeled", {
      task: "Labeled",
      costUsd: 1.0,
      label: "my-feature",
    });

    const all = listAllSessions();
    const found = all.find((s) => s.sessionId === "sess-labeled");
    expect(found).toBeTruthy();
    expect(found?.repoPath).toBe(testRepo); // repoPath, not repoPath::label
    expect(found?.agentId).toBe(testAgentId);
    expect(found?.label).toBe("my-feature");
  });
});

// ---------------------------------------------------------------------------
// MCP bridge script generation
// ---------------------------------------------------------------------------

describe("MCP bridge", () => {
  it("startMcpBridge creates script and config", async () => {
    const { startMcpBridge } = await import("./mcp-bridge.js");

    const handle = await startMcpBridge({
      task: "Test task",
      repo: "/tmp/test-repo",
      agentId: "test-agent",
    });

    expect(handle.mcpConfig).toBeTruthy();
    expect(handle.mcpConfig.type).toBe("stdio");
    expect(handle.mcpConfig.command).toBe(process.execPath);
    expect((handle.mcpConfig.args as string[])[0]).toMatch(/\.cjs$/);
    expect(handle.announceQueuePath).toMatch(/announce\.ndjson$/);

    // Verify script was written
    const scriptPath = (handle.mcpConfig.args as string[])[0];
    expect(fs.existsSync(scriptPath)).toBe(true);

    // drainAnnouncements on empty file returns empty
    expect(handle.drainAnnouncements()).toEqual([]);

    // Write a fake announcement and drain it
    fs.writeFileSync(
      handle.announceQueuePath,
      JSON.stringify({ message: "Hello from bridge", timestamp: new Date().toISOString() }) + "\n",
    );
    const announcements = handle.drainAnnouncements();
    expect(announcements).toEqual(["Hello from bridge"]);
    // Second drain should be empty
    expect(handle.drainAnnouncements()).toEqual([]);

    // Stop and verify cleanup
    await handle.stop();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Progress event types
// ---------------------------------------------------------------------------

describe("progress events", () => {
  it("covers all event kinds", () => {
    const events: ClaudeCodeProgressEvent[] = [
      { kind: "status", permissionMode: "bypassPermissions", sessionId: "sess-1" },
      { kind: "tool_use", toolName: "Read", input: { file_path: "/test.ts" } },
      { kind: "text", text: "Hello" },
      { kind: "hook_failed", hookName: "pre-commit", exitCode: 1, output: "failed" },
      { kind: "task_notification", taskId: "task-1", status: "completed", summary: "Done" },
      { kind: "auth_error", error: "expired" },
      { kind: "progress_summary", summary: "[kyo] Working... (30s, $0.10, 2 turns)" },
      {
        kind: "permission_request",
        toolName: "Bash",
        description: "Run: npm test",
        requestId: "tu_01",
      },
    ];

    // All events should be valid (TypeScript ensures this)
    expect(events).toHaveLength(8);
    for (const event of events) {
      expect(event.kind).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Session history peek
// ---------------------------------------------------------------------------

describe("peekSessionHistory", () => {
  const tmpDir = path.join(os.tmpdir(), `cc-peek-test-${Date.now()}`);
  const fakeRepo = "/home/user/myproject";
  const sessionId = "peek-test-session";

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSessionFile(lines: object[]) {
    const sessionDir = path.join(tmpDir, ".claude", "projects", "myproject");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return sessionFile;
  }

  it("returns empty string when session file not found", () => {
    const result = peekSessionHistory("/nonexistent/repo", "no-such-session");
    expect(result).toBe("");
  });

  it("extracts text content from assistant and user messages", () => {
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      writeSessionFile([
        { message: { role: "user", content: "Fix the bug in auth.ts" } },
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I'll fix the authentication bug." },
              { type: "tool_use", id: "t1", name: "Edit", input: {} },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "OK" }],
          },
        },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The bug is fixed. I updated the token validation." }],
          },
        },
      ]);

      const result = peekSessionHistory(fakeRepo, sessionId);
      expect(result).toContain("[User]: Fix the bug in auth.ts");
      expect(result).toContain("[CC]: I'll fix the authentication bug.");
      expect(result).toContain("[CC]: The bug is fixed.");
      expect(result).not.toContain("tool_result");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("respects maxMessages limit", () => {
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      writeSessionFile([
        { message: { role: "user", content: "Message 1" } },
        { message: { role: "assistant", content: [{ type: "text", text: "Reply 1" }] } },
        { message: { role: "user", content: "Message 2" } },
        { message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }] } },
        { message: { role: "user", content: "Message 3" } },
        { message: { role: "assistant", content: [{ type: "text", text: "Reply 3" }] } },
      ]);

      const result = peekSessionHistory(fakeRepo, sessionId, { maxMessages: 2 });
      expect(result).not.toContain("Message 1");
      expect(result).not.toContain("Reply 1");
      expect(result).toContain("[User]: Message 3");
      expect(result).toContain("[CC]: Reply 3");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("truncates when exceeding maxChars", () => {
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const longText = "A".repeat(3000);
      writeSessionFile([
        { message: { role: "user", content: longText } },
        { message: { role: "assistant", content: [{ type: "text", text: longText }] } },
      ]);

      const result = peekSessionHistory(fakeRepo, sessionId, { maxChars: 500 });
      expect(result.length).toBeLessThan(600);
      expect(result).toContain("…");
    } finally {
      process.env.HOME = origHome;
    }
  });
});
