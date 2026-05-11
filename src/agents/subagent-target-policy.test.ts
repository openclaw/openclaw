import { describe, expect, it } from "vitest";
import {
  resolveSpawnAllowlistFromEnv,
  resolveSubagentAllowedTargetIds,
  resolveSubagentTargetPolicy,
} from "./subagent-target-policy.js";

describe("subagent target policy", () => {
  it("defaults to requester-only when no allowlist is configured", () => {
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "main",
        requestedAgentId: "main",
      }),
    ).toEqual({ ok: true });
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "other",
      requestedAgentId: "other",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject other agent");
    }
    expect(result.allowedText).toBe("main");
  });

  it("keeps omitted agentId self-spawns allowed even when an allowlist is configured", () => {
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "task-manager",
        targetAgentId: "task-manager",
        allowAgents: ["planner"],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects explicit self-targets when the configured allowlist excludes the requester", () => {
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "task-manager",
      targetAgentId: "task-manager",
      requestedAgentId: "task-manager",
      allowAgents: ["planner", "checker"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject explicit self-target");
    }
    expect(result.allowedText).toBe("checker, planner");
    expect(result.error).toBe(
      "agentId is not allowed for sessions_spawn (allowed: checker, planner)",
    );
  });

  it("resolves allowed target ids without auto-adding requester for explicit allowlists", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["planner"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: false,
      allowedIds: ["planner"],
    });
  });

  describe("SPAWN_ALLOWLIST env-var fallback (#79490)", () => {
    it("returns undefined when SPAWN_ALLOWLIST is unset, blank, or comma-only", () => {
      expect(resolveSpawnAllowlistFromEnv({})).toBeUndefined();
      expect(resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "" })).toBeUndefined();
      expect(resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "   " })).toBeUndefined();
      expect(resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: ", , ," })).toBeUndefined();
    });

    it("parses a single wildcard so docker-compose `SPAWN_ALLOWLIST=*` enables any-target spawns", () => {
      expect(resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "*" })).toEqual(["*"]);
      const result = resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "basic-agent",
        requestedAgentId: "basic-agent",
        allowAgents: resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "*" }),
      });
      expect(result).toEqual({ ok: true });
    });

    it("parses comma-separated agent ids and trims whitespace", () => {
      expect(
        resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "basic-agent, planner ,checker" }),
      ).toEqual(["basic-agent", "planner", "checker"]);
    });

    it("rejects targets that are not in the env-var allowlist with the same message as config-driven rejection", () => {
      const result = resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "stranger",
        requestedAgentId: "stranger",
        allowAgents: resolveSpawnAllowlistFromEnv({ SPAWN_ALLOWLIST: "planner,checker" }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected env-var allowlist to reject unknown target");
      }
      expect(result.error).toBe(
        "agentId is not allowed for sessions_spawn (allowed: checker, planner)",
      );
    });
  });
});
