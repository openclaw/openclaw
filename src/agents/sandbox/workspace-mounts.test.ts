import { describe, expect, it } from "vitest";
import { appendWorkspaceMountArgs } from "./workspace-mounts.js";

describe("appendWorkspaceMountArgs", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace:rw" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:ro" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: access,
    });

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro"]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:rw"]);
  });

  it.each([
    { propagation: "rprivate" as const, expected: "/tmp/workspace:/workspace:rw" },
    { propagation: "rslave" as const, expected: "/tmp/workspace:/workspace:rw,rslave" },
    { propagation: "rshared" as const, expected: "/tmp/workspace:/workspace:rw,rshared" },
  ])(
    "appends propagation mode to workspace mount for workspaceMountPropagation=$propagation",
    ({ propagation, expected }) => {
      const args: string[] = [];
      appendWorkspaceMountArgs({
        args,
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/agent-workspace",
        workdir: "/workspace",
        workspaceAccess: "rw",
        workspaceMountPropagation: propagation,
      });

      expect(args).toContain(expected);
    },
  );

  it("does not append propagation to agent workspace mount", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "rw",
      workspaceMountPropagation: "rslave",
    });

    expect(args).toContain("/tmp/workspace:/workspace:rw,rslave");
    expect(args).toContain("/tmp/agent-workspace:/agent");
  });
});
