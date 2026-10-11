import { describe, expect, it } from "vitest";
import { computeSandboxBrowserConfigHash, computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import type { SandboxDockerConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

function createHashInput(docker: Partial<SandboxDockerConfig> = {}) {
  return {
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      ...docker,
    },
    workspaceAccess: "rw" as const,
    workspaceDir: "/tmp/workspace",
    agentWorkspaceDir: "/tmp/workspace",
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
  };
}

function createBrowserHashInput() {
  return {
    ...createHashInput(),
    securityEpoch: "epoch-v1",
    browser: {
      cdpPort: 9222,
      cdpSourceRange: undefined,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      noVncEnabled: true,
      autoStartTimeoutMs: 12000,
    },
  };
}

describe("sandbox config hashes", () => {
  it("preserves bind order", () => {
    const binds = ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"];
    const left = computeSandboxConfigHash(createHashInput({ binds }));
    const right = computeSandboxConfigHash(createHashInput({ binds: binds.toReversed() }));
    expect(left).not.toBe(right);
  });

  it("preserves browser bind order", () => {
    const shared = createBrowserHashInput();
    const binds = ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"];
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      docker: { ...shared.docker, binds },
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      docker: { ...shared.docker, binds: binds.toReversed() },
    });
    expect(left).not.toBe(right);
  });
});
