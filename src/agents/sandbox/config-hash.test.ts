import { describe, expect, it } from "vitest";
import type { SandboxDockerConfig } from "./types.js";
import { computeSandboxBrowserConfigHash, computeSandboxConfigHash } from "./config-hash.js";

function createDockerConfig(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return {
    image: "openclaw-sandbox:test",
    containerPrefix: "openclaw-sbx-",
    workdir: "/workspace",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    network: "none",
    capDrop: ["ALL"],
    env: { LANG: "C.UTF-8" },
    dns: ["1.1.1.1", "8.8.8.8"],
    extraHosts: ["host.docker.internal:host-gateway"],
    binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
    ...overrides,
  };
}

describe("computeSandboxConfigHash", () => {
  it("ignores object key order", () => {
    const shared = {
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          LANG: "C.UTF-8",
          B: "2",
          A: "1",
        },
      }),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          A: "1",
          B: "2",
          LANG: "C.UTF-8",
        },
      }),
    });
    expect(left).toBe(right);
  });

  it("treats primitive array order as significant", () => {
    const shared = {
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        dns: ["1.1.1.1", "8.8.8.8"],
      }),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        dns: ["8.8.8.8", "1.1.1.1"],
      }),
    });
    expect(left).not.toBe(right);
  });
});

describe("computeSandboxBrowserConfigHash", () => {
  it("treats docker bind order as significant", () => {
    const shared = {
      browser: {
        cdpPort: 9222,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
      },
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
      }),
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/cache:/cache:ro", "/tmp/workspace:/workspace:rw"],
      }),
    });
    expect(left).not.toBe(right);
  });
});
