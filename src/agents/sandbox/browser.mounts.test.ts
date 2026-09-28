import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";

describe("ensureSandboxBrowser managed mounts", () => {
  const harness = createSandboxBrowserTestHarness();
  const {
    execContainer,
    resolveDockerSourceNamespace,
    dockerMocks,
    bridgeMocks,
    tempDirs,
    buildConfig,
    ensureTestSandboxBrowser,
    requireDockerCreateArgs,
  } = harness;

  it("uses daemon sources for browser workspace and materialized skill mounts", async () => {
    const root = realpathSync(harness.testWorkspaceDir);
    for (const dir of ["agent/skills", "materialized/skills"]) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/browser-state", destination: root, writable: true },
    ]);
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: path.join(root, "agent"),
      agentWorkspaceDir: path.join(root, "agent"),
      skillsWorkspaceDir: path.join(root, "materialized"),
      cfg,
    });
    const binds = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
    expect(binds).toContain("/host/browser-state/agent:/workspace:z");
    expect(binds).not.toContain("/host/browser-state/agent:/agent:ro,z");
    expect(binds).toContain(
      "/host/browser-state/materialized/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
    );
  });

  it("preserves a hot browser and bridge when a descendant tmpfs was removed", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const bridge = { containerName, bridge: { server: { listening: true } } };
    harness.BROWSER_BRIDGES.set("session:test", bridge);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue("old-tmpfs-config");
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [
          { Type: "bind", Source: harness.testWorkspaceDir, Destination: "/workspace", RW: true },
        ],
        Tmpfs: { "/workspace/cache": "rw" },
      }),
      stderr: "",
      code: 0,
    });
    const cfg = buildConfig(false);
    cfg.docker.tmpfs = [];
    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg,
      }),
    ).rejects.toThrow("openclaw sandbox recreate --browser --session session:test");
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    expect(harness.BROWSER_BRIDGES.get("session:test")).toBe(bridge);
  });

  it("skips browser user binds that conflict with protected skill overlay container paths", async () => {
    const workspaceDir = tempDirs.make("openclaw-browser-mounts-");
    const customRoot = tempDirs.make("openclaw-browser-mounts-");
    mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    cfg.docker.dangerouslyAllowReservedContainerTargets = true;
    cfg.browser.binds = [`${customRoot}:/workspace/skills:rw`];

    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
    });

    const bindArgs = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const protectedMount = `${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`;
    const protectedMountIdx = bindArgs.indexOf(protectedMount);

    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(bindArgs).not.toContain(customMount);
    expect(protectedMountIdx).toBeGreaterThan(workspaceMountIdx);
  });
});
