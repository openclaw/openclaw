import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config module before importing the module under test
vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(),
}));

import { resolveStateDir } from "../config/paths.js";
import { __testing } from "./session-lock-startup-cleanup.js";

const { cleanAllAgentSessionLocks } = __testing;

describe("session-lock-startup-cleanup", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-startup-"));
    agentsDir = path.join(tmpDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    // Configure mock to use our temp directory
    vi.mocked(resolveStateDir).mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("cleans stale locks from multiple agent sessions directories", async () => {
    const nowMs = Date.now();

    // Create two agents with sessions directories
    const agent1Sessions = path.join(agentsDir, "main", "sessions");
    const agent2Sessions = path.join(agentsDir, "test-agent", "sessions");
    await fs.mkdir(agent1Sessions, { recursive: true });
    await fs.mkdir(agent2Sessions, { recursive: true });

    // Create stale lock (dead PID) in agent1
    const staleLock1 = path.join(agent1Sessions, "session-a.jsonl.lock");
    await fs.writeFile(
      staleLock1,
      JSON.stringify({
        pid: 999_999, // Non-existent PID
        createdAt: new Date(nowMs - 120_000).toISOString(),
      }),
      "utf8",
    );

    // Create stale lock (old timestamp) in agent2
    const staleLock2 = path.join(agent2Sessions, "session-b.jsonl.lock");
    await fs.writeFile(
      staleLock2,
      JSON.stringify({
        pid: process.pid, // Alive but too old
        createdAt: new Date(nowMs - 120_000).toISOString(),
      }),
      "utf8",
    );

    // Create fresh lock (should NOT be removed)
    const freshLock = path.join(agent1Sessions, "session-c.jsonl.lock");
    await fs.writeFile(
      freshLock,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(nowMs - 1_000).toISOString(),
      }),
      "utf8",
    );

    const result = await cleanAllAgentSessionLocks({
      staleMs: 30_000,
    });

    expect(result.totalCleaned).toBe(2);
    expect(result.agentsCleaned.toSorted()).toEqual(["main", "test-agent"]);

    // Verify stale locks are removed
    await expect(fs.access(staleLock1)).rejects.toThrow();
    await expect(fs.access(staleLock2)).rejects.toThrow();

    // Verify fresh lock is preserved
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });

  it("handles missing agents directory gracefully", async () => {
    // Remove the agents directory
    await fs.rm(agentsDir, { recursive: true, force: true });

    const result = await cleanAllAgentSessionLocks({ staleMs: 30_000 });

    expect(result.totalCleaned).toBe(0);
    expect(result.agentsCleaned).toEqual([]);
  });

  it("handles agents without sessions directory", async () => {
    // Create agent directory without sessions subdirectory
    const agentDir = path.join(agentsDir, "no-sessions-agent");
    await fs.mkdir(agentDir, { recursive: true });

    const result = await cleanAllAgentSessionLocks({ staleMs: 30_000 });

    expect(result.totalCleaned).toBe(0);
    expect(result.agentsCleaned).toEqual([]);
  });

  it("skips non-directory entries in agents folder", async () => {
    // Create a file instead of a directory
    await fs.writeFile(path.join(agentsDir, "not-an-agent.txt"), "test");

    const result = await cleanAllAgentSessionLocks({ staleMs: 30_000 });

    expect(result.totalCleaned).toBe(0);
    expect(result.agentsCleaned).toEqual([]);
  });
});
