import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerClaudeCodeRun,
  getClaudeCodeRun,
  listClaudeCodeRuns,
  getClaudeCodeRunsBySession,
  resetClaudeCodeRegistryForTests,
  parseClaudeOutput,
} from "./claude-code-registry.js";

describe("claude-code-registry", () => {
  beforeEach(() => {
    resetClaudeCodeRegistryForTests();
  });

  afterEach(() => {
    resetClaudeCodeRegistryForTests();
  });

  describe("registerClaudeCodeRun", () => {
    it("should register a new run", () => {
      const record = registerClaudeCodeRun({
        runId: "test-run-1",
        sessionKey: "agent:claude-code:workspace:abc123",
        workspacePath: "/tmp/workspace",
        task: "Test task",
        cleanup: "keep",
      });

      expect(record.runId).toBe("test-run-1");
      expect(record.status).toBe("pending");
      expect(record.startedAt).toBeGreaterThan(0);
    });
  });

  describe("getClaudeCodeRun", () => {
    it("should return an existing run", () => {
      registerClaudeCodeRun({
        runId: "test-run-2",
        sessionKey: "agent:claude-code:workspace:abc123",
        workspacePath: "/tmp/workspace",
        task: "Test task",
        cleanup: "keep",
      });

      const record = getClaudeCodeRun("test-run-2");
      expect(record).toBeDefined();
      expect(record?.runId).toBe("test-run-2");
    });

    it("should return undefined for non-existent run", () => {
      const record = getClaudeCodeRun("non-existent");
      expect(record).toBeUndefined();
    });
  });

  describe("listClaudeCodeRuns", () => {
    it("should list all runs", () => {
      registerClaudeCodeRun({
        runId: "run-1",
        sessionKey: "agent:claude-code:workspace:abc",
        workspacePath: "/tmp/w1",
        task: "Task 1",
        cleanup: "keep",
      });

      registerClaudeCodeRun({
        runId: "run-2",
        sessionKey: "agent:claude-code:workspace:def",
        workspacePath: "/tmp/w2",
        task: "Task 2",
        cleanup: "delete",
      });

      const runs = listClaudeCodeRuns();
      expect(runs.length).toBe(2);
    });
  });

  describe("getClaudeCodeRunsBySession", () => {
    it("should return runs for a specific session", () => {
      registerClaudeCodeRun({
        runId: "run-1",
        sessionKey: "session-a",
        workspacePath: "/tmp/w1",
        task: "Task 1",
        cleanup: "keep",
      });

      registerClaudeCodeRun({
        runId: "run-2",
        sessionKey: "session-b",
        workspacePath: "/tmp/w2",
        task: "Task 2",
        cleanup: "keep",
      });

      const runs = getClaudeCodeRunsBySession("session-a");
      expect(runs.length).toBe(1);
      expect(runs[0].runId).toBe("run-1");
    });
  });

  describe("parseClaudeOutput", () => {
    it("should parse session_id from valid JSON", () => {
      const output = JSON.stringify({ session_id: "test-session-123", result: "done" });
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("test-session-123");
    });

    it("should parse sessionId (camelCase) from valid JSON", () => {
      const output = JSON.stringify({ sessionId: "test-session-456", result: "done" });
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("test-session-456");
    });

    it("should parse conversation_id from valid JSON", () => {
      const output = JSON.stringify({ conversation_id: "conv-789", result: "done" });
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("conv-789");
    });

    it("should parse conversationId (camelCase) from valid JSON", () => {
      const output = JSON.stringify({ conversationId: "conv-abc", result: "done" });
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("conv-abc");
    });

    it("should prefer session_id over other fields", () => {
      const output = JSON.stringify({
        session_id: "preferred-id",
        sessionId: "other-id",
        conversation_id: "another-id",
      });
      const result = parseClaudeOutput(output);
      expect(result?.session_id).toBe("preferred-id");
    });

    it("should return null for empty output", () => {
      expect(parseClaudeOutput("")).toBeNull();
      expect(parseClaudeOutput("   ")).toBeNull();
    });

    it("should return null for output without session ID", () => {
      const output = JSON.stringify({ result: "done", status: "ok" });
      expect(parseClaudeOutput(output)).toBeNull();
    });

    it("should extract JSON from mixed output", () => {
      const output = `Some prefix text\n{"session_id": "extracted-id"}\nSome suffix text`;
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("extracted-id");
    });

    it("should return null for invalid JSON", () => {
      expect(parseClaudeOutput("not json at all")).toBeNull();
    });

    it("should handle session_id with empty string", () => {
      const output = JSON.stringify({ session_id: "", result: "done" });
      // Empty string should not be considered a valid session ID
      expect(parseClaudeOutput(output)).toBeNull();
    });

    it("should parse session_id from multi-line output with multiple JSON objects", () => {
      // Simulate Claude CLI output with multiple JSON objects on separate lines
      const output =
        '{"type":"text","text":"Hello"}\n{"session_id":"multi-json-id","result":"done"}';
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("multi-json-id");
    });

    it("should find session_id in first valid JSON line", () => {
      const output =
        'invalid line\n{"session_id":"found-in-second","status":"ok"}\n{"other":"data"}';
      const result = parseClaudeOutput(output);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("found-in-second");
    });
  });
});
