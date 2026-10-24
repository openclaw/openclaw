import fs from "node:fs/promises";
import path from "node:path";
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
  const result = fs.stat(targetPath);
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({ code: "ENOENT" });
}

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

export async function expectFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    await expect(fs.readFile(path.join(root, name), "utf8")).resolves.toBe(contents);
  }
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
