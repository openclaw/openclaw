import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

describe("ensureSandboxBrowser managed mounts", () => {
  const harness = createSandboxBrowserTestHarness();
  const {
    execContainer,
    resolveDockerSourceNamespace,
    dockerMocks,
    bridgeMocks,
    runtimeMocks,
    tempDirs,
    buildConfig,
    ensureTestSandboxBrowser,
    requireDockerCreateArgs,
  } = harness;

  it.each(["none", "ro", "rw"] as const)(
    "uses daemon sources for browser mounts with %s access",
    async (access) => {
      const root = realpathSync(harness.testWorkspaceDir);
      for (const dir of ["private/skills", "agent/skills", "materialized/skills"]) {
        mkdirSync(path.join(root, dir), { recursive: true });
      }
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
        { type: "bind", source: "/host/browser-state", destination: root, writable: true },
      ]);
      const cfg = buildConfig(false);
      cfg.workspaceAccess = access;
      await ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: path.join(root, access === "rw" ? "agent" : "private"),
        agentWorkspaceDir: path.join(root, "agent"),
        skillsWorkspaceDir: path.join(root, "materialized"),
        cfg,
      });
      const binds = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
      expect(binds).toContain(
        `/host/browser-state/${access === "rw" ? "agent" : "private"}:/workspace:${access === "ro" ? "ro,z" : "z"}`,
      );
      expect(binds.includes("/host/browser-state/agent:/agent:ro,z")).toBe(access === "ro");
      if (access === "rw") {
        expect(binds).toContain(
          "/host/browser-state/materialized/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
        );
      }
    },
  );

  it("refuses a hot browser with stale sources without removing it or its bridge", async () => {
    const containerName = "openclaw-sbx-browser-session-test-0661d10a";
    const bridge = { containerName, bridge: { server: { listening: true } } };
    harness.BROWSER_BRIDGES.set("session:test", bridge);
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue("existing-cdp-token");
    dockerMocks.readDockerContainerLabel.mockResolvedValue("pre-fix-hash");
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [{ Type: "bind", Source: "/old/source", Destination: "/workspace", RW: true }],
        Tmpfs: null,
      }),
      stderr: "",
      code: 0,
    });
    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg: buildConfig(false),
      }),
    ).rejects.toThrow("openclaw sandbox recreate --browser --session session:test");
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "rm")).toBeUndefined();
    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    expect(harness.BROWSER_BRIDGES.get("session:test")).toBe(bridge);
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
    // Protected skill overlays are authoritative; a browser bind targeting the same
    // container path is skipped so the read-only skill overlay wins and Docker does
    // not reject the container with a "Duplicate mount point" error.
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
    // User bind is skipped because it conflicts with the protected skill overlay
    expect(bindArgs).not.toContain(customMount);
    // Protected skill overlay is present and appended after user binds
    expect(protectedMountIdx).toBeGreaterThan(workspaceMountIdx);
    expect(runtimeMocks.log).toHaveBeenCalledWith(
      expect.stringContaining(`skipping user bind "${customMount}"`),
    );
  });

  it.each([
    { workspaceAccess: "none", flags: "z", rejectedFlags: "ro,z" },
    { workspaceAccess: "ro", flags: "ro,z", rejectedFlags: "z" },
    { workspaceAccess: "rw", flags: "z", rejectedFlags: "ro,z" },
  ] as const)(
    "uses the main workspace mount permissions for workspaceAccess=$workspaceAccess",
    async ({ workspaceAccess, flags, rejectedFlags }) => {
      const cfg = buildConfig(false);
      cfg.workspaceAccess = workspaceAccess;

      await ensureTestSandboxBrowser({
        scopeKey: "session:test",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg,
      });

      const createArgs = requireDockerCreateArgs();
      expect(createArgs).toContain(`${harness.testWorkspaceDir}:/workspace:${flags}`);
      expect(createArgs).not.toContain(`${harness.testWorkspaceDir}:/workspace:${rejectedFlags}`);
    },
  );

  it("stamps the mount format version label on browser containers", async () => {
    await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    });

    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    const labels = collectDockerFlagValues(createArgs ?? [], "--label");
    expect(labels).toContain(`openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  });
});
