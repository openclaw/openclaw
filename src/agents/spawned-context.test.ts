import { expect, it } from "vitest";
import {
  mapToolContextToSpawnedRunMetadata as mapContext,
  normalizeSpawnedRunMetadata as normalize,
  resolveIngressWorkspaceOverrideForSessionRun as ingressWorkspace,
  resolveSpawnedWorkspaceInheritance as inheritWorkspace,
} from "./spawned-context.js";

const group = { groupId: "g-1", groupChannel: "slack", workspaceDir: "/tmp/ws" };
it("trims spawned metadata text fields and drops empties", () => {
  expect(
    normalize({
      spawnedBy: "  agent:main:subagent:1 ",
      groupId: "  g-1 ",
      groupChannel: "  slack ",
      groupSpace: " ",
      workspaceDir: " /tmp/ws ",
    }),
  ).toEqual({
    spawnedBy: "agent:main:subagent:1",
    ...group,
  });
});

it("maps agent group fields to run metadata shape", () => {
  expect(
    mapContext({
      agentGroupId: "g-1",
      agentGroupChannel: "slack",
      agentGroupSpace: "topic:123",
      workspaceDir: "/tmp/ws",
    }),
  ).toEqual({
    ...group,
    groupSpace: "topic:123",
  });
});

const config = {
  agents: {
    entries: {
      main: { workspace: "/tmp/workspace-main" },
      ops: { workspace: "/tmp/workspace-ops" },
    },
  },
};
const requesterSessionKey = "agent:main:subagent:parent";
it.each([
  [{ requesterSessionKey, explicitWorkspaceDir: " /tmp/explicit " }, "/tmp/explicit"],
  [{ requesterSessionKey, targetAgentId: "ops" }, "/tmp/workspace-ops"],
  [{ requesterSessionKey }, "/tmp/workspace-main"],
  [{}, undefined],
])("inherits the workspace for %j", (context, expected) => {
  expect(inheritWorkspace({ config, ...context })).toBe(expected);
});

it("uses inherited workspaces for spawned runs and managed cwd for dashboard worktrees", () => {
  expect([
    ingressWorkspace({
      spawnedBy: "agent:main:subagent:parent",
      workspaceDir: "/tmp/ws",
      cwd: "/tmp/task",
    }),
    ingressWorkspace({ spawnedBy: "", workspaceDir: "/tmp/ws", cwd: "/tmp/worktree" }),
    ingressWorkspace(),
  ]).toEqual(["/tmp/ws", "/tmp/worktree", undefined]);
});
