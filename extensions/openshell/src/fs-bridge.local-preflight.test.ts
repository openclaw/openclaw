import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import type { OpenShellMirrorBackend } from "./backend.types.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "rejects inaccessible local mirror parents before creating remote directories",
  async () => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-preflight-",
    });
    const lockedDir = path.join(workspace.dir, "locked");
    await fs.mkdir(lockedDir);
    const mkdirpRemotePath = vi
      .fn<OpenShellMirrorBackend["mkdirpRemotePath"]>()
      .mockResolvedValue(undefined);
    const backend: OpenShellMirrorBackend = {
      remoteAgentWorkspaceDir: "/agent",
      mkdirpRemotePath,
      renameRemotePath: vi.fn().mockResolvedValue(undefined),
      removeRemotePath: vi.fn().mockResolvedValue(undefined),
      syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
    };
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir: workspace.dir,
        agentWorkspaceDir: workspace.dir,
        workspaceAccess: "rw",
        containerWorkdir: "/sandbox",
      },
    });
    const bridge = createOpenShellFsBridge({ sandbox, backend });
    await fs.chmod(lockedDir, 0o000);
    try {
      await expect(bridge.mkdirp({ filePath: "locked/nested" })).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(mkdirpRemotePath).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(lockedDir, 0o700);
    }
  },
);
