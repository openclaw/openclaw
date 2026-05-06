import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveQmdAgentDir } from "./qmd-paths.js";

const baseStateDir = "/tmp/state";
const agentId = "agent-x";

describe("resolveQmdAgentDir", () => {
  it("returns the agent-only path when userId is undefined", () => {
    const dir = resolveQmdAgentDir({ stateDir: baseStateDir, agentId });
    expect(dir).toBe(path.join(baseStateDir, "agents", agentId));
  });

  it("appends a users/<encoded> segment when userId is provided", () => {
    const dir = resolveQmdAgentDir({ stateDir: baseStateDir, agentId, userId: "alice" });
    expect(dir.startsWith(path.join(baseStateDir, "agents", agentId, "users") + path.sep)).toBe(
      true,
    );
  });

  it("differs by userId so two users do not collide", () => {
    const a = resolveQmdAgentDir({ stateDir: baseStateDir, agentId, userId: "alice" });
    const b = resolveQmdAgentDir({ stateDir: baseStateDir, agentId, userId: "bob" });
    expect(a).not.toBe(b);
  });

  it("never escapes the agent directory (path traversal attempt)", () => {
    const evil = resolveQmdAgentDir({
      stateDir: baseStateDir,
      agentId,
      userId: "../../etc/passwd",
    });
    const agentBase = path.join(baseStateDir, "agents", agentId);
    expect(evil.startsWith(agentBase + path.sep)).toBe(true);
  });

  it("hash mode uses 32 hex chars by default", () => {
    const dir = resolveQmdAgentDir({ stateDir: baseStateDir, agentId, userId: "alice" });
    const segment = path.basename(dir);
    expect(segment).toMatch(/^[0-9a-f]{32}$/);
  });

  it("whitelist mode preserves safe ids verbatim", () => {
    const dir = resolveQmdAgentDir({
      stateDir: baseStateDir,
      agentId,
      userId: "alice_42",
      encoding: "whitelist",
    });
    expect(path.basename(dir)).toBe("alice_42");
  });

  it("whitelist mode rejects unsafe ids", () => {
    expect(() =>
      resolveQmdAgentDir({
        stateDir: baseStateDir,
        agentId,
        userId: "../etc",
        encoding: "whitelist",
      }),
    ).toThrow();
  });
});
