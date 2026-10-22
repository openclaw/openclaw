import fs from "node:fs/promises";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { OpenShellMirrorBackend } from "./backend.types.js";

const openShellTestWorkspaceRoot = resolvePreferredOpenClawTmpDir();

export function createOpenShellTestWorkspace(label: string): Promise<TempWorkspace> {
  return tempWorkspace({
    rootDir: openShellTestWorkspaceRoot,
    prefix: `openclaw-openshell-${label}-`,
  });
}

export async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.stat(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

export function createMirrorBackendMock() {
  return {
    remoteAgentWorkspaceDir: "/agent",
    mkdirpRemotePath: vi
      .fn<OpenShellMirrorBackend["mkdirpRemotePath"]>()
      .mockResolvedValue(undefined),
    renameRemotePath: vi
      .fn<OpenShellMirrorBackend["renameRemotePath"]>()
      .mockResolvedValue(undefined),
    removeRemotePath: vi
      .fn<OpenShellMirrorBackend["removeRemotePath"]>()
      .mockResolvedValue(undefined),
    syncLocalPathToRemote: vi
      .fn<OpenShellMirrorBackend["syncLocalPathToRemote"]>()
      .mockResolvedValue(undefined),
  } satisfies OpenShellMirrorBackend;
}

export async function createMirrorFsBridgeFixture(workspaceDir: string) {
  const backend = createMirrorBackendMock();
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId: "openshell",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "rw",
      containerWorkdir: "/sandbox",
    },
  });
  const { OpenShellFsBridge } = await import("./fs-bridge.js");
  return { bridge: new OpenShellFsBridge(sandbox, backend) };
}
