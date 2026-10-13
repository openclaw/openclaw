import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import {
  listMemoryFiles,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type MemoryWorkspaceMaintenance = NonNullable<MemoryWorkspaceFiles["maintenance"]>;

export function getMemoryWorkspaceMaintenance(
  workspaceDir: string,
): MemoryWorkspaceMaintenance | undefined {
  const access = getAgentWorkspaceAccess(workspaceDir, "memoryFiles");
  if (!access?.memoryFiles) {
    return undefined;
  }
  const files = access.memoryFiles.maintenance;
  if (!files) {
    throw new WorkspaceAccessUnavailableError("Remote Memory maintenance is unavailable");
  }
  return files;
}

export async function readWorkspaceFile(workspaceDir: string, filePath: string): Promise<Buffer> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  return files ? await files.readFile(filePath) : await fs.readFile(filePath);
}

export async function readWorkspaceText(workspaceDir: string, filePath: string): Promise<string> {
  return (await readWorkspaceFile(workspaceDir, filePath)).toString("utf8");
}

export async function accessWorkspacePath(workspaceDir: string, filePath: string): Promise<void> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  if (files) {
    await files.stat(filePath, true);
  } else {
    await fs.access(filePath);
  }
}

type FileInfo = Pick<
  Stats,
  "size" | "mtimeMs" | "mode" | "isFile" | "isDirectory" | "isSymbolicLink"
>;

export async function inspectWorkspaceFile(
  workspaceDir: string,
  filePath: string,
  followSymlinks = true,
): Promise<FileInfo> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  if (!files) {
    return followSymlinks ? await fs.stat(filePath) : await fs.lstat(filePath);
  }
  const info = await files.stat(filePath, followSymlinks);
  return {
    ...info,
    isFile: () => info.isFile,
    isDirectory: () => info.isDirectory,
    isSymbolicLink: () => info.isSymbolicLink,
  };
}

export async function listWorkspaceDirectory(
  workspaceDir: string,
  directory: string,
): Promise<Array<Pick<Dirent, "name" | "isFile" | "isDirectory" | "isSymbolicLink">>> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  if (!files) {
    return await fs.readdir(directory, { withFileTypes: true });
  }
  return (await files.listDirectory(directory)).map((entry) => ({
    name: entry.name,
    isFile: () => entry.isFile,
    isDirectory: () => entry.isDirectory,
    isSymbolicLink: () => entry.isSymbolicLink,
  }));
}

export async function makeWorkspaceDirectory(
  workspaceDir: string,
  directory: string,
): Promise<void> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  if (files) {
    await files.mkdir(directory);
  } else {
    await fs.mkdir(directory, { recursive: true });
  }
}

export async function renameWorkspacePath(
  workspaceDir: string,
  from: string,
  to: string,
): Promise<void> {
  const files = getMemoryWorkspaceMaintenance(workspaceDir);
  if (files) {
    await files.rename(from, to);
  } else {
    await fs.rename(from, to);
  }
}

export const listWorkspaceMemoryFiles: typeof listMemoryFiles = async (workspaceDir, ...args) => {
  const access = getAgentWorkspaceAccess(workspaceDir, "memoryFiles");
  if (!access?.memoryFiles) {
    return await listMemoryFiles(workspaceDir, ...args);
  }
  return await access.memoryFiles.listFiles(workspaceDir, ...args);
};
