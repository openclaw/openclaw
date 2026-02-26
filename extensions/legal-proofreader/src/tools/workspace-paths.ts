import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";

function isOutsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const relative = path.relative(workspaceRoot, candidatePath);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function resolveCandidatePath(workspaceRoot: string, rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot, trimmed);
  if (isOutsideWorkspace(workspaceRoot, resolved)) {
    throw new Error(`${label} must be within workspace: ${workspaceRoot}`);
  }
  return resolved;
}

async function findExistingAncestor(targetPath: string): Promise<string> {
  let current = path.resolve(path.dirname(targetPath));
  while (true) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Unable to locate existing parent for path: ${targetPath}`);
      }
      current = parent;
    }
  }
}

function resolveWorkspaceRoot(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  if (!resolved.trim()) {
    throw new Error("agents.defaults.workspace is required");
  }
  return resolved;
}

export function resolveConfiguredWorkspace(config: OpenClawConfig): string {
  const workspaceDir = config.agents?.defaults?.workspace?.trim();
  if (!workspaceDir) {
    throw new Error("agents.defaults.workspace is required");
  }
  return resolveWorkspaceRoot(workspaceDir);
}

export async function resolveWorkspaceInputPath(
  workspaceRootRaw: string,
  rawPath: string,
  label: string,
): Promise<string> {
  const workspaceRoot = resolveWorkspaceRoot(workspaceRootRaw);
  const candidate = resolveCandidatePath(workspaceRoot, rawPath, label);

  const stat = await fs.stat(candidate).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`${label} not found: ${candidate}`);
  }

  const real = await fs.realpath(candidate);
  if (isOutsideWorkspace(workspaceRoot, real)) {
    throw new Error(`${label} must be within workspace: ${workspaceRoot}`);
  }

  return real;
}

export async function resolveWorkspaceOutputPath(
  workspaceRootRaw: string,
  rawPath: string,
  label: string,
): Promise<string> {
  const workspaceRoot = resolveWorkspaceRoot(workspaceRootRaw);
  const candidate = resolveCandidatePath(workspaceRoot, rawPath, label);

  const ancestor = await findExistingAncestor(candidate);
  if (isOutsideWorkspace(workspaceRoot, ancestor)) {
    throw new Error(`${label} must be within workspace: ${workspaceRoot}`);
  }

  const existing = await fs.lstat(candidate).catch(() => null);
  if (existing?.isDirectory()) {
    throw new Error(`${label} must be a file path: ${candidate}`);
  }

  if (existing?.isSymbolicLink()) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || isOutsideWorkspace(workspaceRoot, real)) {
      throw new Error(`${label} must be within workspace: ${workspaceRoot}`);
    }
  }

  return candidate;
}
