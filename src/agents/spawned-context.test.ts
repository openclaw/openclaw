import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";

describe("normalizeSpawnedRunMetadata", () => {
  it("trims text fields and drops empties", () => {
    expect(
      normalizeSpawnedRunMetadata({
        spawnedBy: "  agent:main:subagent:1 ",
        groupId: "  group-1 ",
        groupChannel: "  slack ",
        groupSpace: " ",
        workspaceDir: " /tmp/ws ",
      }),
    ).toEqual({
      spawnedBy: "agent:main:subagent:1",
      groupId: "group-1",
      groupChannel: "slack",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("mapToolContextToSpawnedRunMetadata", () => {
  it("maps agent group fields to run metadata shape", () => {
    expect(
      mapToolContextToSpawnedRunMetadata({
        agentGroupId: "g-1",
        agentGroupChannel: "telegram",
        agentGroupSpace: "topic:123",
        workspaceDir: "/tmp/ws",
      }),
    ).toEqual({
      groupId: "g-1",
      groupChannel: "telegram",
      groupSpace: "topic:123",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("resolveSpawnedWorkspaceInheritance", () => {
  it("prefers explicit workspaceDir when provided", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {},
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: " /tmp/explicit ",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("returns undefined for missing requester context", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {},
      requesterSessionKey: undefined,
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("uses target agent workspace when main spawns ai-data-engineer (#40869)", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/Users/tengyilong/.openclaw/workspace" },
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["ai-data-engineer"] },
          },
          {
            id: "ai-data-engineer",
            name: "ai-data-engineer",
            workspace: "/Users/tengyilong/.openclaw/workspace-ai-data-engineer",
          },
        ],
      },
    };

    const targetAgentId = "ai-data-engineer";
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: resolveAgentWorkspaceDir(cfg, targetAgentId),
    });
    expect(resolved).toBe("/Users/tengyilong/.openclaw/workspace-ai-data-engineer");
  });

  it("preserves requester workspace when no target agentId is specified (#40869 regression)", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/Users/tengyilong/.openclaw/workspace" },
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["ai-data-engineer"] },
          },
          {
            id: "ai-data-engineer",
            name: "ai-data-engineer",
            workspace: "/Users/tengyilong/.openclaw/workspace-ai-data-engineer",
          },
        ],
      },
    };

    // When no agentId is provided, targetAgentId defaults to requesterAgentId
    const requesterAgentId = "main";
    const targetAgentId = requesterAgentId;
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: resolveAgentWorkspaceDir(cfg, targetAgentId),
    });
    expect(resolved).toBe("/Users/tengyilong/.openclaw/workspace");
  });
});

describe("resolveIngressWorkspaceOverrideForSpawnedRun", () => {
  it("forwards workspace only for spawned runs", () => {
    expect(
      resolveIngressWorkspaceOverrideForSpawnedRun({
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/ws",
      }),
    ).toBe("/tmp/ws");
    expect(
      resolveIngressWorkspaceOverrideForSpawnedRun({
        spawnedBy: "",
        workspaceDir: "/tmp/ws",
      }),
    ).toBeUndefined();
  });
});
