import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import type { OpenShellMirrorBackend } from "./backend.types.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";

function createBridge(workspaceDir: string) {
  const backend = {
    remoteAgentWorkspaceDir: "/agent",
    mkdirpRemotePath: vi.fn().mockResolvedValue(undefined),
    renameRemotePath: vi.fn().mockResolvedValue(undefined),
    removeRemotePath: vi.fn().mockResolvedValue(undefined),
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  } satisfies OpenShellMirrorBackend;
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId: "openshell",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "rw",
      containerWorkdir: "/sandbox",
    },
  });
  return { backend, bridge: createOpenShellFsBridge({ sandbox, backend }) };
}

it("keeps omitted read limits unlimited and explicit zero limits empty", async () => {
  await using workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-openshell-read-limit-",
  });
  const { bridge } = createBridge(workspace.dir);
  // Omitting the caller limit must not inherit fs-safe's default 16 MiB cap.
  const large = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
  await fs.writeFile(path.join(workspace.dir, "large.bin"), large);
  expect((await bridge.readFile({ filePath: "large.bin" })).equals(large)).toBe(true);
  await expect(bridge.readFile({ filePath: "large.bin", maxBytes: 0 })).rejects.toThrow(
    "Sandbox boundary checks failed",
  );
  await fs.writeFile(path.join(workspace.dir, "empty.bin"), "");
  await expect(bridge.readFile({ filePath: "empty.bin", maxBytes: 0 })).resolves.toEqual(
    Buffer.alloc(0),
  );
});

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "rejects inaccessible local mirror parents before creating remote directories",
  async () => {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-preflight-",
    });
    const lockedDir = path.join(workspace.dir, "locked");
    await fs.mkdir(lockedDir);
    const { backend, bridge } = createBridge(workspace.dir);
    await fs.chmod(lockedDir, 0o000);
    try {
      await expect(bridge.mkdirp({ filePath: "locked/nested" })).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(backend.mkdirpRemotePath).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(lockedDir, 0o700);
    }
  },
);
