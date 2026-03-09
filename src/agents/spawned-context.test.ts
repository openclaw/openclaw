import { describe, expect, it } from "vitest";
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

  it("uses target agent's explicitly configured workspace when targetAgentId is set", () => {
    const config = {
      agents: {
        list: [
          { id: "main", workspace: "/home/user/main-ws" },
          { id: "ct-manager", workspace: "/home/user/ct-manager-ws" },
        ],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: undefined,
      targetAgentId: "ct-manager",
    });
    expect(resolved).toBe("/home/user/ct-manager-ws");
  });

  it("prefers explicit workspace over target agent's workspace", () => {
    const config = {
      agents: {
        list: [
          { id: "main", workspace: "/home/user/main-ws" },
          { id: "ct-manager", workspace: "/home/user/ct-manager-ws" },
        ],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: "/tmp/explicit",
      targetAgentId: "ct-manager",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("falls back to requester workspace when target agent has no explicitly configured workspace", () => {
    const config = {
      agents: {
        list: [
          { id: "main", workspace: "/home/user/main-ws" },
          { id: "ct-manager" }, // no workspace configured
        ],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: undefined,
      targetAgentId: "ct-manager",
    });
    // Should fall back to requester's workspace since target has no explicit workspace
    expect(resolved).toBe("/home/user/main-ws");
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
