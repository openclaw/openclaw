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

export function createMirrorBackendMock(): OpenShellMirrorBackend {
  return {
    remoteAgentWorkspaceDir: "/agent",
    mkdirpRemotePath: vi.fn().mockResolvedValue(undefined),
    renameRemotePath: vi.fn().mockResolvedValue(undefined),
    removeRemotePath: vi.fn().mockResolvedValue(undefined),
    syncLocalPathToRemote: vi.fn().mockResolvedValue(undefined),
  };
}

export async function createMirrorFsBridgeFixture(
  workspaceDir: string,
  backend: OpenShellMirrorBackend = createMirrorBackendMock(),
  workspaceAccess: "rw" | "none" | "ro" = "rw",
) {
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId: "openshell",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess,
      containerWorkdir: "/sandbox",
    },
  });
  const { createOpenShellFsBridge } = await import("./fs-bridge.js");
  return { backend, bridge: createOpenShellFsBridge({ sandbox, backend }) };
}
