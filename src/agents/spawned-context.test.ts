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
      targetAgentId: "ct-manager",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("prefers target agent explicit workspace over requester workspace", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {
        agents: {
          list: [
            { id: "main", workspace: "/tmp/requester" },
            { id: "ct-manager", workspace: "/tmp/target" },
          ],
        },
      },
      requesterSessionKey: "agent:main:subagent:parent",
      targetAgentId: "ct-manager",
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toBe("/tmp/target");
  });

  it("falls back to requester workspace when target agent has no explicit workspace", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {
        agents: {
          list: [{ id: "main", workspace: "/tmp/requester" }, { id: "ct-manager" }],
        },
      },
      requesterSessionKey: "agent:main:subagent:parent",
      targetAgentId: "ct-manager",
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toBe("/tmp/requester");
  });

  it("returns undefined for missing requester context", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {},
      requesterSessionKey: undefined,
      targetAgentId: undefined,
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toBeUndefined();
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
