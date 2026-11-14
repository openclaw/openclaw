// Sandbox user fallback tests cover docker.user resolution from explicit config
// or workspace ownership.
import { describe, expect, it, vi } from "vitest";
import { resolveSandboxDockerUser } from "./docker-user.js";
import type { SandboxDockerConfig } from "./types.js";

const stat = vi.hoisted(() => vi.fn());
// mock-isolation: Workspace ownership fixtures must not read the host filesystem.
vi.mock("node:fs/promises", () => ({ default: { stat } }));

const baseDocker: SandboxDockerConfig = {
  image: "ghcr.io/example/sandbox:latest",
  containerPrefix: "openclaw-sandbox-",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  network: "none",
  capDrop: ["ALL"],
};

describe("resolveSandboxDockerUser", () => {
  it("keeps configured docker.user", async () => {
    const resolved = await resolveSandboxDockerUser({
      backend: "docker",
      docker: { ...baseDocker, user: "2000:2000" },
      workspaceDir: "/tmp/unused",
    });
    expect(resolved.user).toBe("2000:2000");
  });

  it("falls back to workspace ownership when docker.user is unset", async () => {
    stat.mockResolvedValue({ uid: 1001, gid: 1002 });
    const resolved = await resolveSandboxDockerUser({
      backend: "docker",
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBe("1001:1002");
  });

  it("falls back to workspace ownership for mixed-case Docker backend ids", async () => {
    stat.mockResolvedValue({ uid: 1001, gid: 1002 });
    const resolved = await resolveSandboxDockerUser({
      backend: "Docker",
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBe("1001:1002");
  });

  it("falls back to workspace ownership for rootless Podman", async () => {
    stat.mockResolvedValue({ uid: 1001, gid: 1002 });
    const resolved = await resolveSandboxDockerUser({
      backend: "podman",
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBe("1001:1002");
  });

  it("leaves Podman user unset when host ownership IDs are zero", async () => {
    stat.mockResolvedValue({ uid: 0, gid: 0 });
    const docker = { ...baseDocker };
    const resolved = await resolveSandboxDockerUser({
      backend: "podman",
      docker,
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved).toBe(docker);
  });

  it("leaves docker.user unset when workspace stat fails", async () => {
    stat.mockRejectedValue(new Error("ENOENT"));
    const resolved = await resolveSandboxDockerUser({
      backend: "docker",
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBeUndefined();
  });
});
