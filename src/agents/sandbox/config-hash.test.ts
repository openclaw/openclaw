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
  it("ignores object key order", () => {
    const left = computeSandboxConfigHash(
      createHashInput({ env: { LANG: "C.UTF-8", B: "2", A: "1" } }),
    );
    const right = computeSandboxConfigHash(
      createHashInput({ env: { A: "1", B: "2", LANG: "C.UTF-8" } }),
    );
    expect(left).toBe(right);
  });

  it("preserves bind order", () => {
    const binds = ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"];
    const left = computeSandboxConfigHash(createHashInput({ binds }));
    const right = computeSandboxConfigHash(createHashInput({ binds: binds.toReversed() }));
    expect(left).not.toBe(right);
  });

  it("changes when read-only workspace skill mount state changes", () => {
    const shared = createHashInput();
    const withoutSkills = computeSandboxConfigHash({ ...shared, managedMounts: [] });
    const withSkills = computeSandboxConfigHash({
      ...shared,
      managedMounts: ["/tmp/workspace/skills:/workspace/skills:ro"],
    });
    expect(withoutSkills).not.toBe(withSkills);
  });

  it("changes when read-only resource mount state changes", () => {
    const shared = createHashInput();
    const withoutResources = computeSandboxConfigHash(shared);
    const withResources = computeSandboxConfigHash({
      ...shared,
      managedMounts: ["/host/attachments:/openclaw/attachments:ro"],
    });
    expect(withoutResources).not.toBe(withResources);
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

  it("changes when the browser mount format version changes", () => {
    const shared = createBrowserHashInput();
    const left = computeSandboxBrowserConfigHash(shared);
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION - 1,
    });
    expect(left).not.toBe(right);
  });

  it("changes when the browser security epoch changes", () => {
    const shared = createBrowserHashInput();
    const left = computeSandboxBrowserConfigHash(shared);
    const right = computeSandboxBrowserConfigHash({ ...shared, securityEpoch: "epoch-v2" });
    expect(left).not.toBe(right);
  });

  it("changes when cdp source range changes", () => {
    const shared = createBrowserHashInput();
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.21.0.1/32" },
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.22.0.1/32" },
    });
    expect(left).not.toBe(right);
  });
});
