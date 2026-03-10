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
  it("prefers explicit workspaceDir when provided (same-agent)", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {},
      requesterSessionKey: "agent:main:subagent:parent",
      targetAgentId: "main",
      explicitWorkspaceDir: " /tmp/explicit ",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("returns undefined for cross-agent spawn when target has explicit workspace", () => {
    const cfg = {
      agents: {
        list: [
          { id: "orchestrator", workspace: "/home/node/.openclaw/workspace/orchestrator" },
          { id: "programmer", workspace: "/home/node/.openclaw/workspace/programmer" },
        ],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      requesterSessionKey: "agent:orchestrator:subagent:parent",
      targetAgentId: "programmer",
      explicitWorkspaceDir: "/home/node/.openclaw/workspace/orchestrator",
    });
    expect(resolved).toBeUndefined();
  });

  it("inherits when cross-agent spawn but target has no workspace configured", () => {
    const cfg = {
      agents: {
        list: [
          { id: "orchestrator", workspace: "/home/node/.openclaw/workspace/orchestrator" },
          { id: "helper" },
        ],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      requesterSessionKey: "agent:orchestrator:subagent:parent",
      targetAgentId: "helper",
      explicitWorkspaceDir: "/home/node/.openclaw/workspace/orchestrator",
    });
    expect(resolved).toBe("/home/node/.openclaw/workspace/orchestrator");
  });

  it("inherits requester workspace for same-agent spawn", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", workspace: "/home/node/.openclaw/workspace/main" }],
      },
    };
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      requesterSessionKey: "agent:main:subagent:parent",
      targetAgentId: "main",
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toContain("workspace");
    expect(resolved).toContain("main");
  });

  it("returns undefined for missing requester context", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config: {},
      requesterSessionKey: undefined,
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
