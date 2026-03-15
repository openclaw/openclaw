import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateClaudeCodeSessionKey,
  parseClaudeCodeSessionKey,
  isClaudeCodeSessionKey,
  resolveClaudeCodeSession,
  listClaudeCodeSessions,
  deleteClaudeCodeSession,
  cleanupOldSessions,
  updateClaudeSessionId,
  getClaudeSessionId,
} from "./claude-code-sessions.js";

describe("claude-code-sessions", () => {
  const testWorkspace = "/tmp/test-workspace";
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary isolated directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    // Mock os.homedir to return the temp directory to avoid polluting real user data
    vi.spyOn(os, "homedir").mockReturnValue(tempDir);
  });

  afterEach(() => {
    // Restore all mocks
    vi.restoreAllMocks();
    // Clean up the temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("generateClaudeCodeSessionKey", () => {
    it("should generate a session key with workspace hash", () => {
      const key = generateClaudeCodeSessionKey(testWorkspace);
      expect(key).toMatch(/^agent:claude-code:workspace:[a-f0-9]{16}$/);
    });

    it("should generate the same key for the same workspace", () => {
      const key1 = generateClaudeCodeSessionKey(testWorkspace);
      const key2 = generateClaudeCodeSessionKey(testWorkspace);
      expect(key1).toBe(key2);
    });

    it("should generate different keys for different workspaces", () => {
      const key1 = generateClaudeCodeSessionKey("/workspace1");
      const key2 = generateClaudeCodeSessionKey("/workspace2");
      expect(key1).not.toBe(key2);
    });

    it("should normalize workspace paths", () => {
      const key1 = generateClaudeCodeSessionKey("/tmp/test");
      const key2 = generateClaudeCodeSessionKey("/tmp/../tmp/test");
      expect(key1).toBe(key2);
    });
  });

  describe("parseClaudeCodeSessionKey", () => {
    it("should parse a valid session key", () => {
      const key = generateClaudeCodeSessionKey(testWorkspace);
      const parsed = parseClaudeCodeSessionKey(key);
      expect(parsed).not.toBeNull();
      expect(parsed?.workspaceHash).toMatch(/^[a-f0-9]{16}$/);
    });

    it("should return null for invalid keys", () => {
      expect(parseClaudeCodeSessionKey("invalid-key")).toBeNull();
      expect(parseClaudeCodeSessionKey("agent:other:workspace:abc123")).toBeNull();
    });
  });

  describe("isClaudeCodeSessionKey", () => {
    it("should return true for valid claude-code session keys", () => {
      const key = generateClaudeCodeSessionKey(testWorkspace);
      expect(isClaudeCodeSessionKey(key)).toBe(true);
    });

    it("should return false for other session keys", () => {
      expect(isClaudeCodeSessionKey("agent:main:session")).toBe(false);
      expect(isClaudeCodeSessionKey("agent:claude-cli:session")).toBe(false);
    });
  });

  describe("resolveClaudeCodeSession", () => {
    it("should create a new session when resume is false", () => {
      const result = resolveClaudeCodeSession({
        workspacePath: testWorkspace,
        resume: false,
      });
      expect(result.isNew).toBe(true);
      expect(result.sessionKey).toMatch(/^agent:claude-code:workspace:/);
    });

    it("should create a new session when resume is true but no existing session", () => {
      const result = resolveClaudeCodeSession({
        workspacePath: testWorkspace,
        resume: true,
      });
      expect(result.isNew).toBe(true);
    });

    it("should return existing session when resume is true", () => {
      // Create first session
      const first = resolveClaudeCodeSession({
        workspacePath: testWorkspace,
        resume: false,
      });

      // Resume should return the same session
      const second = resolveClaudeCodeSession({
        workspacePath: testWorkspace,
        resume: true,
      });

      expect(second.isNew).toBe(false);
      expect(second.sessionKey).toBe(first.sessionKey);
    });
  });

  describe("listClaudeCodeSessions", () => {
    it("should list all sessions", () => {
      resolveClaudeCodeSession({ workspacePath: "/workspace1", resume: false });
      resolveClaudeCodeSession({ workspacePath: "/workspace2", resume: false });

      const sessions = listClaudeCodeSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe("deleteClaudeCodeSession", () => {
    it("should delete a session", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      const deleted = deleteClaudeCodeSession(testWorkspace);
      expect(deleted).toBe(true);

      const sessions = listClaudeCodeSessions();
      expect(sessions.length).toBe(0);
    });

    it("should return false if session does not exist", () => {
      const deleted = deleteClaudeCodeSession("/nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("cleanupOldSessions", () => {
    it("should not clean up fresh sessions", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      // Fresh sessions should not be cleaned with reasonable maxAge
      const cleaned = cleanupOldSessions(30);
      expect(cleaned).toBe(0);

      const sessions = listClaudeCodeSessions();
      expect(sessions.length).toBe(1);
    });

    it("should clean up sessions older than maxAgeDays", async () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      // Wait a bit to ensure time passes
      await new Promise((r) => setTimeout(r, 10));

      // With very small maxAge, sessions should be cleaned
      // Note: Due to timing, we use a very small window
      const cleaned = cleanupOldSessions(0.0000001);
      expect(cleaned).toBeGreaterThanOrEqual(1);

      const sessions = listClaudeCodeSessions();
      expect(sessions.length).toBe(0);
    });
  });

  describe("updateClaudeSessionId", () => {
    it("should store Claude session ID for an existing session", () => {
      // First create a session
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      // Update with Claude session ID
      const claudeSessionId = "test-claude-session-123";
      const result = updateClaudeSessionId(testWorkspace, claudeSessionId);
      expect(result).toBe(true);

      // Verify it was stored
      const stored = getClaudeSessionId(testWorkspace);
      expect(stored).toBe(claudeSessionId);
    });

    it("should create a new session entry if none exists", () => {
      // No session created yet
      const claudeSessionId = "test-claude-session-456";
      const result = updateClaudeSessionId("/new-workspace", claudeSessionId);
      expect(result).toBe(true);

      // Verify it was stored
      const stored = getClaudeSessionId("/new-workspace");
      expect(stored).toBe(claudeSessionId);
    });

    it("should update existing Claude session ID", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      const firstId = "first-session-id";
      updateClaudeSessionId(testWorkspace, firstId);
      expect(getClaudeSessionId(testWorkspace)).toBe(firstId);

      const secondId = "second-session-id";
      updateClaudeSessionId(testWorkspace, secondId);
      expect(getClaudeSessionId(testWorkspace)).toBe(secondId);
    });

    it("should normalize workspace paths", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      const claudeSessionId = "normalized-session-id";
      updateClaudeSessionId(testWorkspace, claudeSessionId);

      // Should work with different path representations
      const stored = getClaudeSessionId("/tmp/../tmp/test-workspace");
      expect(stored).toBe(claudeSessionId);
    });
  });

  describe("getClaudeSessionId", () => {
    it("should return undefined when no session exists", () => {
      const sessionId = getClaudeSessionId("/nonexistent-workspace");
      expect(sessionId).toBeUndefined();
    });

    it("should return undefined when session exists but no Claude session ID", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });

      const sessionId = getClaudeSessionId(testWorkspace);
      expect(sessionId).toBeUndefined();
    });

    it("should return stored Claude session ID", () => {
      resolveClaudeCodeSession({ workspacePath: testWorkspace, resume: false });
      const claudeSessionId = "stored-session-id";
      updateClaudeSessionId(testWorkspace, claudeSessionId);

      const sessionId = getClaudeSessionId(testWorkspace);
      expect(sessionId).toBe(claudeSessionId);
    });
  });
});
