import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionKeyForRequest } from "./session.js";
import type { OpenClawConfig, SessionEntry } from "../../config/config.js";

const TEST_TMP_DIR = "/tmp/openclaw-session-test";

function createTestConfig(agents: string[], sessionStorePath: string): OpenClawConfig {
  return {
    agents: {
      defaults: {},
      entries: agents.map((id) => ({
        id,
        workspace: `${TEST_TMP_DIR}/workspace-${id}`,
      })),
    },
    session: {
      store: sessionStorePath,
    },
  } as OpenClawConfig;
}

function createSessionEntry(sessionId: string, channel?: string): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    channel: channel || "test",
    chatType: "private",
    lastChannel: channel || "test",
  } as SessionEntry;
}

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_TMP_DIR)) {
      fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    }
  });

  it("should use sessionId to find session even when agentId is specified (issue #60614)", () => {
    const storePath = path.join(TEST_TMP_DIR, "session-store.json");
    const cfg = createTestConfig(["agent1", "agent2"], storePath);

    // Create session entries for both agents
    const targetSessionId = "test-session-123";
    const agent1Store: Record<string, SessionEntry> = {
      "agent:agent1:main": createSessionEntry("agent1-main-session"),
      "agent:agent1:group-abc": createSessionEntry(targetSessionId, "feishu:group:abc"),
    };
    const agent2Store: Record<string, SessionEntry> = {
      "agent:agent2:main": createSessionEntry("agent2-main-session"),
    };

    // Write agent1's store (primary/default)
    fs.writeFileSync(storePath, JSON.stringify(agent1Store, null, 2));

    // Write agent2's store
    const agent2StorePath = path.join(TEST_TMP_DIR, "workspace-agent2", "sessions.json");
    fs.mkdirSync(path.dirname(agent2StorePath), { recursive: true });
    fs.writeFileSync(agent2StorePath, JSON.stringify(agent2Store, null, 2));

    // Test: sessionId should take precedence over agentId
    const result = resolveSessionKeyForRequest({
      cfg,
      agentId: "agent2", // Specify agent2
      sessionId: targetSessionId, // But sessionId belongs to agent1's store
    });

    // Should find the session from agent1's store, not use agent2's main session
    expect(result.sessionKey).toBe("agent:agent1:group-abc");
    expect(result.sessionStore?.[result.sessionKey!]?.sessionId).toBe(targetSessionId);
  });

  it("should find sessionId in primary store when agentId is specified", () => {
    const storePath = path.join(TEST_TMP_DIR, "session-store.json");
    const cfg = createTestConfig(["agent1", "agent2"], storePath);

    const targetSessionId = "primary-store-session";
    const agent1Store: Record<string, SessionEntry> = {
      "agent:agent1:main": createSessionEntry("agent1-main-session"),
      "agent:agent1:custom": createSessionEntry(targetSessionId),
    };

    fs.writeFileSync(storePath, JSON.stringify(agent1Store, null, 2));

    const result = resolveSessionKeyForRequest({
      cfg,
      agentId: "agent2", // Different agent
      sessionId: targetSessionId, // Session exists in agent1's (primary) store
    });

    // Should find the session in the primary store
    expect(result.sessionKey).toBe("agent:agent1:custom");
    expect(result.sessionStore?.[result.sessionKey!]?.sessionId).toBe(targetSessionId);
  });

  it("should fall back to agent's main session when sessionId is not found", () => {
    const storePath = path.join(TEST_TMP_DIR, "session-store.json");
    const cfg = createTestConfig(["agent1"], storePath);

    const agent1Store: Record<string, SessionEntry> = {
      "agent:agent1:main": createSessionEntry("existing-session"),
    };
    fs.writeFileSync(storePath, JSON.stringify(agent1Store, null, 2));

    const result = resolveSessionKeyForRequest({
      cfg,
      agentId: "agent1",
      sessionId: "non-existent-session",
    });

    // Should use the agent's main session since sessionId was not found
    expect(result.sessionKey).toBe("agent:agent1:main");
  });

  it("should use explicit sessionKey when provided", () => {
    const storePath = path.join(TEST_TMP_DIR, "session-store.json");
    const cfg = createTestConfig(["agent1"], storePath);

    const agent1Store: Record<string, SessionEntry> = {
      "agent:agent1:custom": createSessionEntry("custom-session"),
    };
    fs.writeFileSync(storePath, JSON.stringify(agent1Store, null, 2));

    const result = resolveSessionKeyForRequest({
      cfg,
      sessionKey: "agent:agent1:custom",
    });

    expect(result.sessionKey).toBe("agent:agent1:custom");
  });

  it("should derive sessionKey from --to when no sessionId or sessionKey provided", () => {
    const storePath = path.join(TEST_TMP_DIR, "session-store.json");
    const cfg = createTestConfig(["main"], storePath);

    const agent1Store: Record<string, SessionEntry> = {};
    fs.writeFileSync(storePath, JSON.stringify(agent1Store, null, 2));

    const result = resolveSessionKeyForRequest({
      cfg,
      to: "+1234567890",
    });

    // Should derive a session key based on the sender
    expect(result.sessionKey).toMatch(/agent:main:/);
  });
});
