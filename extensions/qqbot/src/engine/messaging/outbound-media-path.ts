import path from "node:path";
import type { OutboundMediaAccessContext } from "./outbound-types.js";

export function mergeMediaLocalRoots(
  ...groups: Array<readonly string[] | undefined>
): string[] | undefined {
  const roots = groups
    .flatMap((group) => group ?? [])
    .map((root) => root.trim())
    .filter(Boolean);
  return roots.length > 0 ? Array.from(new Set(roots)) : undefined;
}

export function resolveOutboundMediaLocalRoots(
  ctx: OutboundMediaAccessContext,
): string[] | undefined {
  return mergeMediaLocalRoots(
    ctx.mediaAccess?.localRoots,
    ctx.mediaLocalRoots,
    ctx.mediaAccess?.workspaceDir ? [ctx.mediaAccess.workspaceDir] : undefined,
  );
}

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    return false;
  }
  const relative = path.relative(resolvedRoot, path.resolve(candidatePath));
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function resolvePathInsideWorkspace(
  workspaceDir: string,
  pathWithinWorkspace: string,
): string | null {
  const mappedPath = path.resolve(workspaceDir, pathWithinWorkspace);
  return isPathWithinRoot(mappedPath, workspaceDir) ? mappedPath : null;
}

export function resolveWorkspacePathCandidate(
  normalizedPath: string,
  workspaceDir?: string,
): string | null {
  if (!workspaceDir) {
    return normalizedPath;
  }
  if (normalizedPath === "/workspace") {
    return workspaceDir;
  }
  if (normalizedPath.startsWith("/workspace/")) {
    return resolvePathInsideWorkspace(workspaceDir, normalizedPath.slice("/workspace/".length));
  }
  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }
  return resolvePathInsideWorkspace(workspaceDir, normalizedPath);
}

export function resolveWorkspacePathCandidates(
  normalizedPath: string,
  workspaceDir?: string,
): string[] {
  const mappedPath = resolveWorkspacePathCandidate(normalizedPath, workspaceDir);
  if (!mappedPath) {
    return [];
  }
  if (mappedPath === normalizedPath) {
    return [normalizedPath];
  }
  return path.isAbsolute(normalizedPath) ? [normalizedPath, mappedPath] : [mappedPath];
}
